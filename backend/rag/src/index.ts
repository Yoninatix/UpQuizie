import express from "express";
import { embed, chat } from "./ollama.js";
import { insertChunks, search, getClient, deleteByDocument, deleteBySubject } from "./milvus.js";
import { extractText } from "./extract.js";
import { query, ensureSchema } from "./db.js";
import { deriveEvidenceQuote, GroundingSource, validateGroundedQuestion } from "./grounding.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "7000", 10);
const ARRAY_BATCH = parseInt(process.env.GEN_BATCH || "8", 10);
const RETRIEVAL_K = Math.max(1, parseInt(process.env.RAG_TOP_K || "2", 10));
const QUERY_CACHE_SIZE = Math.max(0, parseInt(process.env.RAG_QUERY_CACHE_SIZE || "100", 10));
const queryEmbeddingCache = new Map<string, number[]>();
const QUESTION_TYPES = new Set(["mcq", "true_false", "fill_blank", "matching", "essay"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function chunkByWords(text: string, size = 500, overlap = 50): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= size) return [words.join(" ")];
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += size - overlap) {
    chunks.push(words.slice(start, start + size).join(" "));
  }
  return chunks;
}

function extractJSON(s: string): any {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const first = candidate.search(/[[{]/);
  if (first === -1) throw new Error("no JSON found");
  const sub = candidate.slice(first);
  for (let end = sub.length; end > 0; end--) {
    try { return JSON.parse(sub.slice(0, end)); } catch { /* shrink */ }
  }
  throw new Error("could not parse JSON");
}

function toQuestionArray(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed.filter(Boolean);
  if (parsed && Array.isArray(parsed.questions)) return parsed.questions.filter(Boolean);
  if (parsed && typeof parsed === "object" && parsed.prompt) return [parsed];
  return [];
}

function schemaFor(type: string, difficulty: string): string {
  switch (type) {
    case "mcq":
      return `Required fields: type="mcq", difficulty="${difficulty}", topic (string), prompt (string), options (array of 2-6 actual phrases copied from the source), answer (object with integer correct_index).`;
    case "true_false":
      return `Required fields: type="true_false", difficulty="${difficulty}", topic (string), prompt (string), options=["True","False"], answer (object with boolean correct).`;
    case "fill_blank":
      return `Required fields: type="fill_blank", difficulty="${difficulty}", topic (string), prompt (string containing _____), options=null, answer (object with accepted array of actual source phrases).`;
    case "matching":
      return `Required fields: type="matching", difficulty="${difficulty}", topic, prompt, options (object with left and right arrays copied from source), answer (object with one-to-one index pairs).`;
    case "essay":
      return `Required fields: type="essay", difficulty="${difficulty}", topic, prompt, options=null, answer (object with a source-grounded rubric string).`;
    default:
      throw new Error(`unsupported question type: ${type}`);
  }
}

interface DistItem { type: string; difficulty: string; count: number; points: number }

async function insertQuestion(
  jobId: string, subjectId: string, item: DistItem, question: any,
  sourceRef: string, documentId: string
) {
  await query(
    `INSERT INTO generated_questions
       (subject_id, document_id, type, difficulty, points, prompt, options, answer, topic, source_ref, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
    [
      subjectId || null, documentId, item.type, item.difficulty, item.points || 1,
      question.prompt,
      question.options != null ? JSON.stringify(question.options) : null,
      question.answer != null ? JSON.stringify(question.answer) : null,
      question.topic || "", sourceRef,
    ]
  );
  await query(`UPDATE generation_jobs SET generated = generated + 1 WHERE id=$1`, [jobId]);
}

function renderSources(sources: GroundingSource[]): string {
  return sources.map((source, index) =>
    `[SOURCE ${index + 1}; uploaded_document_id=${source.document_id}; chunk=${source.chunk_index ?? "unknown"}]\n${source.text}`
  ).join("\n\n---\n\n");
}

async function retrieveSources(subjectId: string, documentId: string, retrievalQuery: string): Promise<GroundingSource[]> {
  let pool: GroundingSource[] = [];
  try {
    const normalizedQuery = (retrievalQuery.trim() || "key concepts and definitions").toLowerCase().replace(/\s+/g, " ");
    let qvec = queryEmbeddingCache.get(normalizedQuery);
    if (!qvec) {
      qvec = await embed(normalizedQuery);
      if (QUERY_CACHE_SIZE > 0) {
        if (queryEmbeddingCache.size >= QUERY_CACHE_SIZE) {
          const oldest = queryEmbeddingCache.keys().next().value;
          if (oldest) queryEmbeddingCache.delete(oldest);
        }
        queryEmbeddingCache.set(normalizedQuery, qvec);
      }
    }
    const hits = await search(subjectId, qvec, Math.max(12, RETRIEVAL_K * 3), documentId);
    pool = hits.filter((hit) => Boolean(hit.text && hit.document_id));
  } catch (e) {
    console.warn("vector retrieval failed; using uploaded chunks from PostgreSQL", e);
  }

  // This fallback may reduce relevance, but it never permits ungrounded content.
  if (!pool.length) {
    const args: unknown[] = [subjectId];
    const documentFilter = documentId ? " AND dc.document_id=$2" : "";
    if (documentId) args.push(documentId);
    pool = await query<GroundingSource>(
      `SELECT dc.content AS text, dc.document_id::text, dc.chunk_index
         FROM document_chunks dc
         JOIN uploaded_documents ud ON ud.id=dc.document_id
        WHERE dc.subject_id=$1 AND ud.status='ready'${documentFilter}
        ORDER BY dc.created_at DESC, dc.chunk_index
        LIMIT 24`,
      args
    );
  }
  if (!pool.length) {
    throw new Error("No processed uploaded-document chunks are available. Upload a document and wait until it is ready.");
  }
  return pool;
}

function contextFor(pool: GroundingSource[], callNumber: number): GroundingSource[] {
  const start = ((callNumber - 1) * RETRIEVAL_K) % pool.length;
  const selected: GroundingSource[] = [];
  for (let offset = 0; offset < Math.min(RETRIEVAL_K, pool.length); offset++) {
    const source = pool[(start + offset) % pool.length];
    if (!selected.some((item) => item.document_id === source.document_id && item.chunk_index === source.chunk_index)) {
      selected.push(source);
    }
  }
  return selected;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function documentPhrases(text: string): string[] {
  const complexities = text.match(/O\([^)]{1,30}\)/g) || [];
  const headings = Array.from(text.matchAll(/(?:^|[•.;])\s*([A-Z][A-Za-z0-9 /-]{2,35}?)(?=\s*:|\s+-)/g), (match) => match[1].trim());
  const names = text.match(/\b[A-Z][A-Za-z-]{3,}(?:\s+[A-Z][A-Za-z-]{3,}){0,2}\b/g) || [];
  return unique([...complexities, ...headings, ...names]).filter((value) => value.length <= 60);
}

function evidenceWindow(text: string, phrase: string, radius = 180): string {
  const index = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (index < 0) return text.slice(0, radius * 2).trim();
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + phrase.length + radius)).trim();
}

/** Creates mechanically answerable questions when the model cannot satisfy the grounding contract. */
function deterministicQuestion(item: DistItem, source: GroundingSource, ordinal: number, topic: string): any | null {
  const phrases = documentPhrases(source.text);
  const answerPhrase = phrases[ordinal % Math.max(phrases.length, 1)];
  if ((item.type === "mcq" || item.type === "fill_blank") && (!answerPhrase || phrases.length < 2)) return null;
  const quote = answerPhrase ? evidenceWindow(source.text, answerPhrase) : source.text.slice(0, 360).trim();
  const cloze = answerPhrase ? quote.replace(new RegExp(answerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "_____") : "";

  if (item.type === "mcq") {
    const distractors = phrases.filter((value) => value.toLowerCase() !== answerPhrase.toLowerCase()).slice(0, 3);
    const options = unique([answerPhrase, ...distractors]);
    if (options.length < 2) return null;
    const shift = ordinal % options.length;
    const rotated = [...options.slice(shift), ...options.slice(0, shift)];
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `Which option correctly completes this statement? "${cloze}"`,
      options: rotated, answer: { correct_index: rotated.indexOf(answerPhrase) }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "fill_blank") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `Complete the statement: "${cloze}"`,
      options: null, answer: { accepted: [answerPhrase] }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "true_false") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `True or False: "${quote}"`,
      options: ["True", "False"], answer: { correct: true }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "essay") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `Explain the following concept: "${quote}"`,
      options: null,
      answer: { rubric: "Accurately explains the concept without introducing unsupported claims." },
      source_index: 1, source_quote: quote,
    };
  }
  return null;
}

async function runGeneration(
  jobId: string, subjectId: string, documentId: string, topic: string, dist: DistItem[]
): Promise<void> {
  const startedAt = Date.now();
  const seen = new Set<string>();
  const retrievalQuery = [topic, ...dist.map((item) => `${item.difficulty} ${item.type} questions`)]
    .filter(Boolean).join("; ");
  const pool = await retrieveSources(subjectId, documentId, retrievalQuery);

  const genBatch = async (item: DistItem, want: number, callNumber: number) => {
    const sources = contextFor(pool, callNumber);
    const prompt = `You are an exam author. Write ${want} DISTINCT ${item.difficulty} ${item.type} questions${topic ? ` about "${topic}"` : ""}, using ONLY the uploaded source excerpts below.

Return ONLY a JSON array of exactly ${want} objects. Each object must have this schema:
${schemaFor(item.type, item.difficulty)}

Rules:
- Every claim in the question, choices, correct answer, and rubric/pairs must be derived from the excerpts. Never use outside knowledge.
- Question wording must stand alone. Never mention a document, source, material, passage, or excerpt, and never say "according to".
- The service will attach an exact evidence sentence from the most relevant retrieved SOURCE after generation.
- For MCQ, every choice must be a verbatim phrase appearing in an excerpt. Only one may correctly answer the prompt.
- For matching, every left and right item must be a verbatim phrase appearing in the cited SOURCE.
- For fill-blank, every accepted answer must appear verbatim in source_quote.
- If the excerpts cannot support a valid question, return fewer objects. Do not invent content or placeholders.
- All questions must be different from each other.
- Output a valid JSON array only. No explanation.

Uploaded source excerpts:
${renderSources(sources)}`;
    try {
      const output = await chat(prompt, {
        json: true, temperature: 0.25, numPredict: Math.min(3072, want * 260 + 250),
      });
      return { questions: toQuestionArray(extractJSON(output)), sources };
    } catch (e) {
      console.error(`batch generation failed (${item.type}/${item.difficulty})`, e);
      return { questions: [] as any[], sources };
    }
  };

  const tryInsert = async (item: DistItem, question: any, sources: GroundingSource[]): Promise<boolean> => {
    const normalizedPrompt = String(question?.prompt || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedPrompt || seen.has(normalizedPrompt)) return false;
    let lastReason = "no retrieved source supports this candidate";
    for (let index = 0; index < sources.length; index++) {
      question.source_index = index + 1;
      question.source_quote = deriveEvidenceQuote(question, item.type, sources[index].text);
      const grounding = validateGroundedQuestion(question, item.type, sources);
      if (!grounding.valid || !grounding.source || !grounding.sourceQuote) {
        lastReason = grounding.reason || lastReason;
        continue;
      }
      seen.add(normalizedPrompt);
      await insertQuestion(jobId, subjectId, item, question, grounding.sourceQuote, grounding.source.document_id);
      return true;
    }
    console.warn("deterministic grounding rejected question:", lastReason);
    return false;
  };

  for (const item of dist) {
    const target = item.count || 1;
    let produced = 0;
    let call = 0;
    // One batched LLM call per batch: retrieve -> augment -> generate.
    const maxCalls = Math.ceil(target / ARRAY_BATCH);
    while (produced < target && call < maxCalls) {
      call++;
      const batch = await genBatch(item, Math.min(ARRAY_BATCH, target - produced), call);
      for (const question of batch.questions) {
        if (produced >= target) break;
        if (await tryInsert(item, question, batch.sources)) produced++;
      }
    }
    // The fallback is assembled directly from exact uploaded-document phrases;
    // unlike an LLM fallback, its answer and distractor provenance is mechanical.
    let fallbackAttempt = 0;
    while (produced < target && fallbackAttempt < pool.length * 3) {
      const source = pool[fallbackAttempt % pool.length];
      const candidate = deterministicQuestion(item, source, fallbackAttempt, topic);
      fallbackAttempt++;
      if (!candidate) continue;
      const normalizedPrompt = candidate.prompt.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(normalizedPrompt)) continue;
      const grounding = validateGroundedQuestion(candidate, item.type, [source]);
      if (!grounding.valid || !grounding.source || !grounding.sourceQuote) continue;
      seen.add(normalizedPrompt);
      await insertQuestion(jobId, subjectId, item, candidate, grounding.sourceQuote, grounding.source.document_id);
      produced++;
    }
    if (produced < target) {
      throw new Error(
        `Generated ${produced}/${target} validated ${item.type}/${item.difficulty} questions. ` +
        "The remaining candidates were rejected because their questions, choices, or answers were not fully supported by uploaded documents."
      );
    }
    console.log(`item ${item.type}/${item.difficulty}: produced ${produced}/${target} validated questions in ${call} LLM call(s)`);
  }
  await query(`UPDATE generation_jobs SET status='done', finished_at=now() WHERE id=$1`, [jobId]);
  console.log(`generation job ${jobId} completed in ${Date.now() - startedAt}ms (top-k=${RETRIEVAL_K})`);
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/process", async (req, res) => {
  const { document_id, subject_id, file_path } = req.body || {};
  if (!document_id || !file_path) return res.status(400).json({ error: "document_id and file_path required" });
  try {
    const text = await extractText(file_path);
    const chunks = chunkByWords(text, 500, 50);
    if (!chunks.length) return res.status(422).json({ error: "no extractable text" });
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      vectors.push({
        document_id, subject_id: subject_id || "", chunk_index: i,
        text: chunks[i].slice(0, 8000), embedding: await embed(chunks[i]),
      });
    }
    const milvusIds = await insertChunks(vectors);
    for (let i = 0; i < chunks.length; i++) {
      await query(
        `INSERT INTO document_chunks (document_id, subject_id, chunk_index, content, milvus_id) VALUES ($1,$2,$3,$4,$5)`,
        [document_id, subject_id || null, i, chunks[i], milvusIds[i] ? Number(milvusIds[i]) : null]
      );
    }
    res.json({ chunks: chunks.length });
  } catch (e: any) {
    console.error("process error", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/document/:id", async (req, res) => {
  try { await deleteByDocument(req.params.id); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/subject/:id", async (req, res) => {
  try { await deleteBySubject(req.params.id); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/generate", async (req, res) => {
  const { subject_id, document_id, topic, distribution } = req.body || {};
  if (!subject_id) return res.status(400).json({ error: "subject_id is required" });
  const dist: DistItem[] = Array.isArray(distribution) && distribution.length
    ? distribution : [{ type: "mcq", difficulty: "medium", count: 3, points: 5 }];
  if (dist.some((item) => !QUESTION_TYPES.has(item.type) || !DIFFICULTIES.has(item.difficulty) ||
      !Number.isInteger(item.count) || item.count < 1 || item.count > 100 ||
      !Number.isInteger(item.points) || item.points < 1)) {
    return res.status(400).json({ error: "invalid question distribution" });
  }

  try {
    const args: unknown[] = [subject_id];
    const documentFilter = document_id ? " AND dc.document_id=$2" : "";
    if (document_id) args.push(document_id);
    const chunks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM document_chunks dc
       JOIN uploaded_documents ud ON ud.id=dc.document_id
       WHERE dc.subject_id=$1 AND ud.status='ready'${documentFilter}`, args
    );
    if (Number(chunks[0]?.count || 0) === 0) {
      return res.status(422).json({ error: "No ready uploaded document is available for grounded generation." });
    }
    const requested = dist.reduce((sum, item) => sum + item.count, 0);
    const rows = await query<{ id: string }>(
      `INSERT INTO generation_jobs (subject_id, status, requested) VALUES ($1,'running',$2) RETURNING id`,
      [subject_id, requested]
    );
    const jobId = rows[0].id;
    res.status(202).json({ job_id: jobId, requested });
    runGeneration(jobId, subject_id, document_id || "", topic || "", dist).catch(async (e) => {
      console.error("generation job failed", e);
      await query(
        `UPDATE generation_jobs SET status='error', error=$2, finished_at=now() WHERE id=$1`,
        [jobId, String(e?.message || e)]
      );
    });
  } catch (e: any) {
    console.error("generate error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/job/:id", async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, status, requested, generated, error FROM generation_jobs WHERE id=$1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "job not found" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/grade", async (req, res) => {
  const { model_answer, student_answer, max_points } = req.body || {};
  try {
    const [a, b] = await Promise.all([embed(model_answer || ""), embed(student_answer || "")]);
    const similarity = cosine(a, b);
    res.json({ points: Math.round(Math.max(0, similarity) * (max_points || 10)), similarity });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

app.listen(PORT, async () => {
  console.log(`RAG service listening on :${PORT} (batch ${ARRAY_BATCH}, top-k ${RETRIEVAL_K}, query-cache ${QUERY_CACHE_SIZE})`);
  ensureSchema().catch((e) => console.warn("ensureSchema deferred:", e.message));
  getClient().catch((e) => console.warn("milvus warmup deferred:", e.message));
});
