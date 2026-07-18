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
// How many LLM generations may run at once. Keep this <= the Ollama server's
// OLLAMA_NUM_PARALLEL so concurrent requests are batched on the GPU rather than
// queued. Overlapping independent candidates is the main lever on wall time.
const GEN_CONCURRENCY = Math.max(1, parseInt(process.env.GEN_CONCURRENCY || "4", 10));
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
  // Output that hit the num_predict cap loses the array's closing bracket and
  // the shrink loop above cannot recover it. Salvage every complete top-level
  // object so a truncated batch still yields its finished candidates.
  const objects: any[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(sub.slice(start, i + 1))); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  if (objects.length) return objects;
  throw new Error("could not parse JSON");
}

// Strips source-referential lead-ins ("According to the text, ...") so an
// otherwise-valid candidate is repaired instead of rejected by the style
// validator. Anything the rewrite cannot fix is still caught by validation.
const SOURCE_REF =
  /\b(?:according to|based on|as (?:stated|described|mentioned|shown|discussed)(?: in| above)?|per)\s+(?:the\s+)?(?:uploaded\s+)?(?:document|text|passage|excerpt|source|reading|material|article|content)[^,.:;?]*[,.:;]?\s*/gi;

function sanitizePrompt(prompt: string): string {
  let out = String(prompt || "").replace(SOURCE_REF, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:?])/g, "$1").trim();
  if (out) out = out[0].toUpperCase() + out.slice(1);
  return out;
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
      return `Required fields: type="mcq", difficulty="${difficulty}", topic (string), prompt (string), options (array of exactly 4 distinct phrases copied from the source, ordered as A, B, C, D), answer (object with integer correct_index from 0 to 3).`;
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

interface DistItem { type: string; difficulty: string; count: number; points: number; topic?: string }

function difficultyGuidance(difficulty: string): string {
  if (difficulty === "easy") return "Test a basic fact, definition, name, date, or simple concept.";
  if (difficulty === "hard") return "Require analysis, comparison, explanation, or application using only the supplied content.";
  return "Require understanding or a connection between ideas, not just recall.";
}

function sourceGroundedFact(fact: string, sources: GroundingSource[]): boolean {
  const stop = new Set(["this", "that", "with", "from", "which", "their", "there", "about", "into", "only"]);
  const tokens = fact.toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((token) => !stop.has(token)) || [];
  const source = sources.map((item) => item.text).join(" ").toLowerCase();
  return new Set(tokens.filter((token) => source.includes(token))).size >= 2;
}

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

async function retrieveSources(subjectId: string, documentIds: string[], retrievalQuery: string): Promise<GroundingSource[]> {
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
    const hits = await search(subjectId, qvec, Math.max(12, RETRIEVAL_K * 3), documentIds);
    pool = hits.filter((hit) => Boolean(hit.text && hit.document_id));
  } catch (e) {
    console.warn("vector retrieval failed; using uploaded chunks from PostgreSQL", e);
  }

  // This fallback may reduce relevance, but it never permits ungrounded content.
  if (!pool.length) {
    const args: unknown[] = [subjectId];
    const documentFilter = documentIds.length ? " AND dc.document_id = ANY($2::uuid[])" : "";
    if (documentIds.length) args.push(documentIds);
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

function splitTopicList(topic: unknown, topics: unknown): string[] {
  const raw = Array.isArray(topics) && topics.length
    ? topics
    : typeof topic === "string" ? topic.split(/[;\n,]+/) : [];
  return unique(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean));
}

function splitDistributionByTopics(dist: DistItem[], topics: string[]): DistItem[] {
  if (topics.length <= 1) {
    return dist.map((item) => ({ ...item, topic: topics[0] || item.topic }));
  }
  const expanded: DistItem[] = [];
  for (const item of dist) {
    const count = Math.max(1, item.count || 1);
    const base = Math.floor(count / topics.length);
    const extra = count % topics.length;
    topics.forEach((topic, index) => {
      const topicCount = base + (index < extra ? 1 : 0);
      if (topicCount > 0) expanded.push({ ...item, count: topicCount, topic });
    });
  }
  return expanded;
}

function documentPhrases(text: string): string[] {
  const complexities = text.match(/O\([^)]{1,30}\)/g) || [];
  const headings = Array.from(text.matchAll(/(?:^|[•.;])\s*([A-Z][A-Za-z0-9 /-]{2,35}?)(?=\s*:|\s+-)/g), (match) => match[1].trim());
  const names = text.match(/\b[A-Z][A-Za-z-]{3,}(?:\s+[A-Z][A-Za-z-]{3,}){0,2}\b/g) || [];
  const blocked = new Set([
    "example", "given", "input", "output", "code", "page", "solution",
    "therefore", "however", "moreover", "thus", "hence", "note",
  ]);
  return unique([...complexities, ...headings, ...names]).filter((value) =>
    value.length <= 60 && !blocked.has(value.toLowerCase())
  );
}

function conciseEvidence(text: string, phrase: string): string {
  const index = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (index < 0) return "";
  const units = text.split(/\s*•\s*|(?<=[.!?])\s+/).map((unit) => unit.trim()).filter(Boolean);
  const unit = units.find((candidate) =>
    candidate.toLowerCase().includes(phrase.toLowerCase()) &&
    candidate.split(/\s+/).length >= 5 && candidate.split(/\s+/).length <= 32
  );
  if (unit) return unit;

  // Preserve whole words around the answer when PDF extraction removed sentence boundaries.
  const before = text.slice(0, index).trim().split(/\s+/).filter(Boolean).slice(-10);
  const after = text.slice(index + phrase.length).trim().split(/\s+/).filter(Boolean).slice(0, 10);
  return [...before, phrase, ...after].join(" ").trim();
}

function documentPairs(text: string): Array<{ left: string; right: string; evidence: string }> {
  const pairs: Array<{ left: string; right: string; evidence: string }> = [];
  const units = text.split(/\s*•\s*|(?<=[.!?])\s+/).map((unit) => unit.trim()).filter(Boolean);
  for (const unit of units) {
    const match = unit.match(/^([A-Za-z][A-Za-z0-9() /&+-]{2,40}):\s*(.{2,100})$/);
    if (!match) continue;
    const left = match[1].trim();
    const right = match[2].trim().split(/\s+/).slice(0, 10).join(" ");
    const key = `${left.toLowerCase()}|${right.toLowerCase()}`;
    if (right.length >= 2 && !pairs.some((pair) => `${pair.left.toLowerCase()}|${pair.right.toLowerCase()}` === key)) {
      pairs.push({ left, right, evidence: unit });
    }
  }
  return pairs;
}

/** Creates mechanically answerable questions when the model cannot satisfy the grounding contract. */
function deterministicQuestion(item: DistItem, source: GroundingSource, ordinal: number, topic: string): any | null {
  const phrases = documentPhrases(source.text);
  let answerPhrase = "";
  let quote = "";
  let cloze = "";
  for (let offset = 0; offset < phrases.length; offset++) {
    const candidate = phrases[(ordinal + offset) % phrases.length];
    const evidence = conciseEvidence(source.text, candidate);
    const candidateCloze = evidence.replace(new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "_____");
    if (candidateCloze.includes("_____") && candidateCloze.replace("_____", "").split(/\s+/).filter(Boolean).length >= 4) {
      answerPhrase = candidate; quote = evidence; cloze = candidateCloze; break;
    }
  }
  if (!quote) {
    const words = source.text.trim().split(/\s+/).slice(0, 24);
    quote = words.join(" ");
  }
  if ((item.type === "mcq" || item.type === "fill_blank") && (!answerPhrase || phrases.length < (item.type === "mcq" ? 4 : 2))) return null;

  if (item.type === "mcq") {
    const complexityAnswer = /^O\(/i.test(answerPhrase);
    const preferred = phrases.filter((value) => /^O\(/i.test(value) === complexityAnswer);
    const parallelDistractors = preferred.filter((value) => value.toLowerCase() !== answerPhrase.toLowerCase());
    const distractors = (parallelDistractors.length > 0 ? parallelDistractors : phrases)
      .filter((value) => value.toLowerCase() !== answerPhrase.toLowerCase()).slice(0, 3);
    const options = unique([answerPhrase, ...distractors]);
    if (options.length !== 4) return null;
    const shift = ordinal % options.length;
    const rotated = [...options.slice(shift), ...options.slice(0, shift)];
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: cloze,
      options: rotated, answer: { correct_index: rotated.indexOf(answerPhrase) }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "fill_blank") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `Fill in the blank:\n${cloze}`,
      options: null, answer: { accepted: [answerPhrase] }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "true_false") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `True or False: ${quote}`,
      options: ["True", "False"], answer: { correct: true }, source_index: 1, source_quote: quote,
    };
  }
  if (item.type === "matching") {
    let allPairs = documentPairs(source.text);
    if (allPairs.length < 2) {
      allPairs = phrases.map((phrase) => ({
        left: phrase,
        right: conciseEvidence(source.text, phrase),
        evidence: conciseEvidence(source.text, phrase),
      })).filter((pair) => pair.right.split(/\s+/).length >= 4)
        .filter((pair, index, all) => all.findIndex((item) => item.right.toLowerCase() === pair.right.toLowerCase()) === index);
    }
    if (allPairs.length < 2) return null;
    // Rotate through the available pairs so successive ordinals produce
    // different valid sets instead of sliding past the end of the list.
    const size = Math.min(3, allPairs.length);
    const startIndex = (ordinal * size) % allPairs.length;
    const pairs = Array.from({ length: size }, (_, index) => allPairs[(startIndex + index) % allPairs.length])
      .filter((pair, index, all) => all.findIndex((p) => p.left.toLowerCase() === pair.left.toLowerCase()) === index);
    if (pairs.length < 2) return null;
    const left = pairs.map((pair) => pair.left);
    const right = pairs.map((pair) => pair.right).reverse();
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Selected topic",
      prompt: "Match each term with its corresponding statement.",
      options: { left, right },
      answer: { pairs: pairs.map((_, index) => [index, pairs.length - 1 - index]) },
      source_index: 1, source_quote: pairs[0].evidence,
    };
  }
  if (item.type === "essay") {
    return {
      type: item.type, difficulty: item.difficulty, topic: topic || "Uploaded material",
      prompt: `Explain this concept in your own words: "${quote}"`,
      options: null,
      answer: { rubric: "Accurately explains the concept without introducing unsupported claims." },
      source_index: 1, source_quote: quote,
    };
  }
  return null;
}

/** Bounded-concurrency scheduler: runs at most `max` tasks at once, queues the rest. */
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (active < max && queue.length) { active++; queue.shift()!(); }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
      pump();
    });
}

async function runGeneration(
  jobId: string, subjectId: string, documentIds: string[], topic: string, dist: DistItem[]
): Promise<void> {
  const startedAt = Date.now();
  const seen = new Set<string>();
  // Promise-valued so concurrent candidates sharing a source key await one
  // extraction instead of each firing its own (cache-stampede under concurrency).
  const factCache = new Map<string, Promise<string[]>>();

  const genBatch = async (
    item: DistItem, want: number, callNumber: number, pool: GroundingSource[], topicFocus: string
  ) => {
    // MCQ facts are extracted once and reused. Rotating context on every
    // candidate caused repeated extraction calls and multi-minute jobs.
    const sources = contextFor(pool, item.type === "mcq" ? 1 : callNumber);
    if (item.type === "mcq") {
      const sourceKey = sources.map((source) => `${source.document_id}:${source.chunk_index ?? "?"}`).join("|");
      let factsPromise = factCache.get(sourceKey);
      if (!factsPromise) {
        factsPromise = (async () => {
          const factOutput = await chat(`You are a fact extractor.

Extract exactly 5 short, important factual statements from the TEXT.

Rules:
- Use only information explicitly present in the text.
- Add no new information and make no questions or explanations.
- Each fact must contain one clear idea and be directly verifiable.
- Write every fact in English.

Return only five numbered lines:
1. ...
2. ...
3. ...
4. ...
5. ...

TEXT:
${renderSources(sources)}`, {
            temperature: 0.2, topP: 0.85, topK: 30, repeatPenalty: 1.2, numPredict: 180,
          });
          return factOutput.split(/\r?\n/).map((line) => line.trim())
            .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
            .filter((line) => line.length >= 8 && sourceGroundedFact(line, sources)).slice(0, 5);
        })();
        // If extraction fails, don't poison the cache — let the next wave retry.
        factsPromise.catch(() => factCache.delete(sourceKey));
        factCache.set(sourceKey, factsPromise);
      }
      const facts = await factsPromise;
      if (!facts.length) return { questions: [] as any[], sources };
      const fact = facts[(callNumber - 1) % facts.length];

      try {
        const mcqOutput = await chat(`You are a quiz writer.

Turn the FACT into ONE natural, standalone ${item.difficulty} multiple-choice question${topicFocus ? ` about "${topicFocus}"` : ""}.

Rules:
- The uploaded content is the only source of knowledge. Use only the fact; preserve its meaning and add no outside information, assumptions, or invented details.
- Write the question and all choices in English only.
- Preserve technical terms, symbols, and acronyms exactly as they appear in the fact. Never guess or invent an acronym expansion.
- ${difficultyGuidance(item.difficulty)} Do not create difficulty through complicated vocabulary.
- Use simple, natural language appropriate for students and make the item sound like a classroom quiz.
- Test an important concept or understanding rather than a tiny incidental detail.
- Do not copy the fact as a sentence-completion question.
- Never refer to a document, text, passage, reading, or statement.
- Provide exactly four concise options and exactly one correct answer.
- Every option must contain meaningful answer text. Never output placeholders or labels such as "A", "option A", or "choice A" as option text.
- Distractors must be plausible but clearly incorrect according to the fact. Avoid ambiguity, tricks, double negatives, and overly complex sentences.
- If the fact cannot support one clear question and answer, return an empty JSON array.
- Before responding, verify that the answer is supported, the wording is natural and understandable, exactly one option is correct, and the requested difficulty is satisfied.

Return one JSON object only. Do not use markdown.
Required fields:
- type: the string "mcq"
- difficulty: the string "${item.difficulty}"
- topic: a short topic name
- prompt: the complete English question
- options: an array containing four actual answer choices in A-to-D order
- answer: an object containing correct_index, an integer from 0 to 3

Write the real question and real choices directly. Do not copy field descriptions into their values.

        FACT:
${fact}`, {
          schema: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["mcq"] },
              difficulty: { type: "string", enum: [item.difficulty] },
              topic: { type: "string" },
              prompt: { type: "string" },
              options: {
                type: "array", minItems: 4, maxItems: 4,
                items: { type: "string", minLength: 2 },
              },
              answer: {
                type: "object",
                properties: { correct_index: { type: "integer", enum: [0, 1, 2, 3] } },
                required: ["correct_index"],
              },
            },
            required: ["type", "difficulty", "topic", "prompt", "options", "answer"],
          },
          temperature: 0.2, topP: 0.85, topK: 30, repeatPenalty: 1.2, numPredict: 300,
        });
        const questions = toQuestionArray(extractJSON(mcqOutput));
        if (!questions.length) return { questions: [] as any[], sources };
        const question = questions[0];
        // Normalize harmless small-model schema drift before deterministic review.
        question.type = "mcq";
        question.difficulty = item.difficulty;
        question.topic = typeof question.topic === "string" ? question.topic : (topicFocus || "Uploaded material");
        question.source_fact = fact;
        if (typeof question.prompt !== "string" && typeof question.question === "string") {
          question.prompt = question.question;
        }
        if (!Array.isArray(question.options)) {
          question.options = question.options ?? question.choices ?? question.answers ?? question.alternatives;
        }
        if (!Array.isArray(question.options) && question.options && typeof question.options === "object") {
          const optionObject = question.options;
          question.options = ["A", "B", "C", "D"]
            .map((key) => optionObject[key] ?? optionObject[key.toLowerCase()])
            .filter((option) => option != null);
        }
        if (!Array.isArray(question.options)) {
          const topLevelOptions = ["A", "B", "C", "D"]
            .map((key) => question[key] ?? question[key.toLowerCase()] ?? question[`option_${key.toLowerCase()}`])
            .filter((option) => option != null);
          if (topLevelOptions.length) question.options = topLevelOptions;
        }
        if (typeof question.options === "string") {
          question.options = question.options.split(/\r?\n|\s*[|;]\s*/).map((value: string) => value.trim()).filter(Boolean);
        }
        if (Array.isArray(question.options)) {
          question.options = question.options.map((option: unknown) =>
            String(typeof option === "object" && option !== null
              ? ((option as any).text ?? (option as any).value ?? (option as any).option ?? "")
              : option).replace(/^\s*(?:option\s*)?[A-D][.):\-]\s*/i, "").trim());
        }
        let reviewedIndex = -1;
        if (Array.isArray(question.options) && question.options.length === 4) {
          const reviewOutput = await chat(`You are an educational assessment reviewer.

Use only the FACT below. Check whether exactly one choice correctly answers the QUESTION.
If exactly one choice is directly supported, set valid to true and return its zero-based index (A=0, B=1, C=2, D=3).
If the question is ambiguous, unsupported, or has zero/multiple correct choices, set valid to false.

FACT:
${fact}

QUESTION:
${question.prompt}

CHOICES:
${question.options.map((option: string, index: number) => `${String.fromCharCode(65 + index)}. ${option}`).join("\n")}`, {
            schema: {
              type: "object",
              properties: {
                valid: { type: "boolean" },
                correct_index: { type: "integer", enum: [0, 1, 2, 3] },
              },
              required: ["valid", "correct_index"],
            },
            temperature: 0, topP: 0.85, topK: 30, repeatPenalty: 1.1, numPredict: 40,
          });
          const review = extractJSON(reviewOutput);
          if (review?.valid === true && Number.isInteger(review.correct_index)) {
            reviewedIndex = review.correct_index;
          } else {
            console.warn("MCQ answer reviewer rejected candidate");
            return { questions: [] as any[], sources };
          }
        }
        const rawAnswer = reviewedIndex >= 0 ? reviewedIndex : question.answer?.correct_index ?? question.answer?.correct ??
          question.answer?.correct_option ?? question.answer?.correct_answer ??
          question.correct_index ?? question.correct_option ?? question.correct_answer ?? question.correctAnswer ?? question.answer;
        let correctIndex = -1;
        if (typeof rawAnswer === "number" && Number.isInteger(rawAnswer)) {
          correctIndex = rawAnswer;
        } else if (typeof rawAnswer === "string") {
          const value = rawAnswer.trim();
          const letter = value.match(/^(?:option\s*)?([A-D])(?:[.):\-])?$/i);
          if (letter) correctIndex = letter[1].toUpperCase().charCodeAt(0) - 65;
          else if (/^[0-3]$/.test(value)) correctIndex = Number(value);
          else if (Array.isArray(question.options)) {
            correctIndex = question.options.findIndex((option: unknown) =>
              String(option).trim().toLowerCase() === value.toLowerCase());
          }
        }
        question.answer = { correct_index: correctIndex };
        return { questions: [question], sources };
      } catch (e) {
        console.error(`three-stage MCQ generation failed (${item.difficulty})`, e);
        return { questions: [] as any[], sources };
      }
    }

    const prompt = `You are an expert educational assessment generator. Write up to ${want} DISTINCT ${item.difficulty} ${item.type} questions${topicFocus ? ` about "${topicFocus}"` : ""}, using ONLY the uploaded source excerpts below.

Return ONLY a JSON array containing no more than ${want} objects. Each object must have this schema:
${schemaFor(item.type, item.difficulty)}

Rules:
- Use only information explicitly contained in the excerpts. Never use outside knowledge, infer unsupported facts, or invent content.
- ${difficultyGuidance(item.difficulty)} Never make a question harder through difficult vocabulary.
- Every question and answer must be directly supported by the excerpts. If there is not enough information for a valid question, omit it.
- Measure understanding of the content rather than unrelated general knowledge.
- Identify useful main ideas, facts, definitions, processes, comparisons, causes and effects, lists, statistics, and conclusions before writing questions.
- Spread questions across different supplied excerpts and concepts. Do not concentrate all questions on the first section.
- Question wording must stand alone. Never mention a document, source, material, passage, or excerpt, and never say "according to".
- Use formal academic quiz language with a concise, direct question stem.
- Write one unambiguous idea per question. Avoid tricks, subjective opinions, double negatives, and wording inconsistent with the source.
- Use natural, varied question forms appropriate to the concept. Do not repeat the same opening or rely on stock phrases such as "Which of the following correctly completes the statement below?"
- Every prompt must be a natural, standalone examination question that tests the concept itself.
- Never begin with or use source-referential/meta wording such as "According to the document", "Based on the passage/text", "From the article", "According to the reading", "As stated above", "The passage states", or "The document explains".
- Never use completion wrappers such as "Which statement completes the sentence", "Complete the statement", "Fill in the blank from the passage", or "The following statement".
- Do not turn a copied source sentence into a question by merely adding "what", "which", or a blank. First identify the taught concept and the knowledge being tested, then write a new direct question in your own wording.
- Keep the question stem below 45 words whenever possible.
- Keep answer choices brief, parallel in style, and clearly distinguishable.
- Always provide the complete answer object required by the question type; never omit the correct answer, accepted answers, pairs, or essay rubric.
- Do not use conversational wording, instructions to the teacher, or meta-commentary.
- Do not include page numbers, raw code dumps, broken extraction fragments, or unnecessary symbols.
- Do not copy a long source passage into the question; include only the information necessary to answer it.
- The service will attach an exact evidence sentence from the most relevant retrieved SOURCE after generation.
- Easy questions test explicit facts, definitions, names, or numbers. Medium questions test relationships, comparisons, meaning, or cause and effect. Hard questions test application, analysis, or interpretation that is fully supported by the excerpts.
- For MCQ, provide exactly four distinct options. Every option must be a verbatim phrase appearing in an excerpt, exactly one option may answer the prompt, distractors must be plausible, and the correct position should vary across questions.
- For true/false, the statement must be directly verifiable from an excerpt and have one definite truth value.
- For a false true/false item, change only one important fact from the supported statement.
- For fill-blank, replace exactly one important word or short phrase with _____. There must be only one correct answer.
- For essay, ask students to explain a concept discussed in the source and provide a rubric containing the key points expected in a correct answer.
- For matching, match source terms with their definitions; every left and right item must be supported by the cited SOURCE.
- For fill-blank, every accepted answer must appear verbatim in source_quote.
- If the excerpts cannot support a valid question, return fewer objects. Do not invent content or placeholders.
- All questions must be different from each other.
- Before responding, silently verify that every item and answer is supported, every MCQ has exactly four options and one correct answer, and the set covers different parts of the supplied content.
- Output a valid JSON array only. No prose or markdown.

Required internal workflow (perform silently before producing JSON):
1. Read every supplied source excerpt completely.
2. Treat each labeled SOURCE and its coherent paragraphs/topics as logical sections.
3. Extract the key concepts from every section: main ideas, facts, definitions, processes, comparisons, causes and effects, lists, statistics, and conclusions.
4. Rank those concepts by their importance to understanding the supplied content. Prefer central and repeatedly supported concepts over incidental details.
5. Allocate questions proportionally across the sections and important concepts. Ensure broad coverage; do not take all questions from one section when multiple sections can support valid questions.
6. Verify the correct answer for every candidate against the supplied source text. Reject any candidate whose answer is absent, ambiguous, or only inferable through outside knowledge.
7. Return only the validated questions in the required JSON schema above.

Uploaded source excerpts:
${renderSources(sources)}`;
    try {
      const output = await chat(prompt, {
        json: true, temperature: 0.25, numPredict: Math.min(2048, want * 230 + 200),
      });
      return { questions: toQuestionArray(extractJSON(output)), sources };
    } catch (e) {
      console.error(`batch generation failed (${item.type}/${item.difficulty})`, e);
      return { questions: [] as any[], sources };
    }
  };

  const tryInsert = async (item: DistItem, question: any, sources: GroundingSource[]): Promise<boolean> => {
    question.prompt = sanitizePrompt(question?.prompt);
    if (item.topic) question.topic = item.topic;
    const normalizedPrompt = String(question?.prompt || "").toLowerCase().replace(/\s+/g, " ").trim();
    // Matching questions legitimately share a stock prompt; their identity is
    // the left-hand item set, so include it in the duplicate key.
    const dedupKey = item.type === "matching" && Array.isArray(question?.options?.left)
      ? `${item.topic || ""}|${normalizedPrompt}|${JSON.stringify(question.options.left).toLowerCase()}`
      : `${item.topic || ""}|${normalizedPrompt}`;
    if (!normalizedPrompt || seen.has(dedupKey)) return false;
    let lastReason = "no retrieved source supports this candidate";
    for (let index = 0; index < sources.length; index++) {
      question.source_index = index + 1;
      question.source_quote = deriveEvidenceQuote(question, item.type, sources[index].text);
      const grounding = validateGroundedQuestion(question, item.type, sources);
      if (!grounding.valid || !grounding.source || !grounding.sourceQuote) {
        lastReason = grounding.reason || lastReason;
        continue;
      }
      seen.add(dedupKey);
      await insertQuestion(jobId, subjectId, item, question, grounding.sourceQuote, grounding.source.document_id);
      return true;
    }
    console.warn("deterministic grounding rejected question:", lastReason);
    return false;
  };

  // Shared GPU budget across every candidate and every distribution row, so
  // total in-flight LLM work stays at GEN_CONCURRENCY no matter how many rows.
  const limit = createLimiter(GEN_CONCURRENCY);

  const processItem = async (item: DistItem) => {
    const target = item.count || 1;
    const topicFocus = item.topic || topic;
    const retrievalQuery = [topicFocus, `${item.difficulty} ${item.type} questions`]
      .filter(Boolean).join("; ");
    const pool = await retrieveSources(subjectId, documentIds, retrievalQuery);
    let produced = 0;
    let call = 0;
    // MCQ uses a per-candidate multi-stage pipeline (extract fact -> write ->
    // review), so each call yields one candidate and we over-generate at a
    // 20:3 ratio. The other types return several candidates per call, so a
    // much smaller call budget reaches the same candidate count far faster.
    const perCall = item.type === "mcq" ? 1 : Math.min(4, target);
    const maxCalls = item.type === "mcq"
      ? Math.max(target, Math.ceil(target * 20 / 3))
      : Math.max(2, Math.ceil(target / perCall) * 3);
    // Issue candidates in concurrent waves instead of strictly one at a time.
    // Independent candidates overlap on the GPU (bounded by `limit`) and share
    // the cached source facts, so a wave adds at most one fact-extraction call.
    while (produced < target && call < maxCalls) {
      const remaining = target - produced;
      const waveSize = item.type === "mcq"
        ? Math.min(remaining, maxCalls - call)
        : Math.min(Math.max(1, Math.ceil(remaining / perCall)), maxCalls - call);
      const waveCalls = Array.from({ length: waveSize }, () => ++call);
      const batches = await Promise.all(waveCalls.map((n) =>
        limit(() => genBatch(item, Math.min(perCall, remaining), n, pool, topicFocus))));
      for (const batch of batches) {
        for (const question of batch.questions) {
          if (produced >= target) break;
          if (await tryInsert(item, question, batch.sources)) produced++;
        }
        if (produced >= target) break;
      }
    }
    // The small local model sometimes cannot satisfy the strict grounding
    // contract at all for a type (matching is the usual offender). Rather than
    // failing the row, build mechanically grounded questions straight from the
    // uploaded chunks; they pass the same validators as LLM candidates.
    if (produced < target) {
      let ordinal = 0;
      for (let attempt = 0; attempt < pool.length * 6 && produced < target; attempt++) {
        const source = pool[attempt % pool.length];
        const question = deterministicQuestion(item, source, ordinal++, topicFocus);
        if (question && await tryInsert(item, question, [source])) produced++;
      }
    }
    if (produced < target) {
      if (produced === 0) {
        throw new Error(
          `Generated 0/${target} validated ${item.type}/${item.difficulty} questions. ` +
          "The uploaded material did not support enough grounded questions of this type."
        );
      }
      console.warn(
        `Partial generation: kept ${produced}/${target} validated ${item.type}/${item.difficulty} questions; ` +
        "rejected candidates were discarded."
      );
    }
    console.log(`item ${item.type}/${item.difficulty}${topicFocus ? `/${topicFocus}` : ""}: produced ${produced}/${target} validated questions in ${call} LLM call(s)`);
  };

  // Distribution rows are independent; run them concurrently under the shared
  // limiter. One failing row must not discard the questions the other rows
  // produced, so collect failures instead of rejecting the whole job.
  const results = await Promise.allSettled(dist.map(processItem));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => String((result.reason as any)?.message || result.reason));
  const [job] = await query<{ generated: number }>(
    `SELECT generated FROM generation_jobs WHERE id=$1`, [jobId]);
  if (failures.length && !(Number(job?.generated) > 0)) {
    throw new Error(failures.join(" | "));
  }
  await query(
    `UPDATE generation_jobs SET status='done', error=$2, finished_at=now() WHERE id=$1`,
    [jobId, failures.length ? `Some questions could not be generated: ${failures.join(" | ")}` : null]);
  console.log(`generation job ${jobId} completed in ${Date.now() - startedAt}ms (top-k=${RETRIEVAL_K}, rowFailures=${failures.length})`);
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
  const { subject_id, document_id, document_ids, topic, topics, distribution } = req.body || {};
  if (!subject_id) return res.status(400).json({ error: "subject_id is required" });
  const selectedDocumentIds = Array.from(new Set(
    (Array.isArray(document_ids) ? document_ids : document_id ? [document_id] : [])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
  ));
  if (!selectedDocumentIds.length) {
    return res.status(400).json({ error: "select at least one uploaded document" });
  }
  const dist: DistItem[] = Array.isArray(distribution) && distribution.length
    ? distribution : [{ type: "mcq", difficulty: "medium", count: 3, points: 5 }];
  if (dist.some((item) => !QUESTION_TYPES.has(item.type) || !DIFFICULTIES.has(item.difficulty) ||
      !Number.isInteger(item.count) || item.count < 1 || item.count > 100 ||
      !Number.isInteger(item.points) || item.points < 1)) {
    return res.status(400).json({ error: "invalid question distribution" });
  }
  const selectedTopics = splitTopicList(topic, topics);
  const generationDist = splitDistributionByTopics(dist, selectedTopics);

  try {
    const args: unknown[] = [subject_id];
    const documentFilter = " AND dc.document_id = ANY($2::uuid[])";
    args.push(selectedDocumentIds);
    const chunks = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM document_chunks dc
       JOIN uploaded_documents ud ON ud.id=dc.document_id
       WHERE dc.subject_id=$1 AND ud.status='ready'${documentFilter}`, args
    );
    if (Number(chunks[0]?.count || 0) === 0) {
      return res.status(422).json({ error: "No ready uploaded document is available for grounded generation." });
    }
    const requested = generationDist.reduce((sum, item) => sum + item.count, 0);
    const rows = await query<{ id: string }>(
      `INSERT INTO generation_jobs (subject_id, status, requested) VALUES ($1,'running',$2) RETURNING id`,
      [subject_id, requested]
    );
    const jobId = rows[0].id;
    res.status(202).json({ job_id: jobId, requested });
    runGeneration(jobId, subject_id, selectedDocumentIds, selectedTopics.join("; "), generationDist).catch(async (e) => {
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
