export interface GroundingSource {
  text: string;
  document_id: string;
  chunk_index?: number;
  score?: number;
}

export interface GroundedQuestion {
  type?: string;
  prompt?: string;
  options?: unknown;
  answer?: unknown;
  topic?: string;
  source_index?: number;
  source_quote?: string;
  source_fact?: string;
}

export interface GroundingResult {
  valid: boolean;
  reason?: string;
  source?: GroundingSource;
  sourceQuote?: string;
}

function normalized(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

function appearsIn(value: unknown, source: string): boolean {
  const needle = normalized(value);
  return needle.length > 0 && normalized(source).includes(needle);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !v.trim())) return null;
  return value as string[];
}

function meaningfulTokens(value: unknown): Set<string> {
  const stop = new Set([
    "this", "that", "with", "from", "what", "which", "where", "when", "does", "have", "into", "true", "false",
    "primary", "purpose", "characteristic", "describes", "result", "condition", "operation", "concept", "following",
  ]);
  return new Set(normalized(value).replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length >= 4 && !stop.has(token)));
}

/** Selects an exact sentence from the uploaded chunk instead of trusting an LLM citation. */
export function deriveEvidenceQuote(question: GroundedQuestion, expectedType: string, sourceText: string): string {
  const answer: any = question.answer;
  const anchors: string[] = [];
  if (expectedType === "mcq" && Array.isArray(question.options)) {
    const options = question.options as unknown[];
    if (Number.isInteger(answer?.correct_index)) {
      anchors.push(String(options[answer.correct_index] ?? ""));
    }
  } else if (expectedType === "fill_blank" && Array.isArray(answer?.accepted)) {
    anchors.push(...answer.accepted.map(String));
  } else if (expectedType === "matching") {
    const options: any = question.options;
    if (Array.isArray(options?.left)) anchors.push(...options.left.map(String));
    if (Array.isArray(options?.right)) anchors.push(...options.right.map(String));
  }

  const sentences = sourceText.match(/[^.!?\n]+[.!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [sourceText.trim()];
  const promptTokens = meaningfulTokens(question.prompt);
  let best = sentences[0] || sourceText.trim();
  let bestScore = -1;
  for (const sentence of sentences) {
    let score = anchors.reduce((sum, anchor) => sum + (appearsIn(anchor, sentence) ? 20 : 0), 0);
    const sentenceTokens = meaningfulTokens(sentence);
    for (const token of promptTokens) if (sentenceTokens.has(token)) score++;
    if (score > bestScore) { best = sentence; bestScore = score; }
  }
  return best;
}

/**
 * Enforces facts we can prove without trusting the LLM: the citation is copied
 * from an uploaded chunk, correct answers occur in that citation, and selectable
 * distractors/items occur somewhere in the retrieved uploaded material.
 */
export function validateGroundedQuestion(
  question: GroundedQuestion,
  expectedType: string,
  sources: GroundingSource[]
): GroundingResult {
  if (!question || typeof question.prompt !== "string" || question.prompt.trim().length < 8) {
    return { valid: false, reason: "missing question prompt" };
  }
  if (question.prompt.trim().split(/\s+/).length > 70 || /\bpage\s+\d+\b/i.test(question.prompt)) {
    return { valid: false, reason: "question prompt is too long or contains extraction artifacts" };
  }
  if (/\baccording to\b|\buploaded document\b|\bsource (?:material|excerpt)\b|\bdocument (?:states|excerpt)\b/i.test(question.prompt)) {
    return { valid: false, reason: "question must not refer to its source document" };
  }
  if (/\bbased on (?:the )?(?:passage|text)\b|\bfrom the article\b|\baccording to the reading\b|\bas stated above\b|\bthe passage states\b|\bthe document explains\b|\bwhich (?:statement )?completes? (?:the |this )?(?:sentence|statement)\b|\bcomplete (?:the |this )?statement\b|\bfill in the blank from (?:the )?passage\b|\bthe following statement\b/i.test(question.prompt)) {
    return { valid: false, reason: "question uses prohibited source-referential or sentence-completion wording" };
  }
  if (/[¿¡]/.test(question.prompt) || /\b(?:cuál|cuáles|qué|por qué|verdadero|falso|siguiente|opciones)\b/i.test(question.prompt)) {
    return { valid: false, reason: "question must be written in English" };
  }
  if (question.type && question.type !== expectedType) {
    return { valid: false, reason: `expected ${expectedType}, received ${question.type}` };
  }
  const sourceIndex = Number(question.source_index);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > sources.length) {
    return { valid: false, reason: "invalid source_index" };
  }
  const source = sources[sourceIndex - 1];
  const sourceContext = sources.map((item) => item.text).join("\n");
  for (const match of question.prompt.matchAll(/\b([A-Z][A-Za-z]+(?:\s+[A-Z]?[A-Za-z]+){1,4})\s*\(([A-Z]{2,})\)/g)) {
    if (!appearsIn(match[1], sourceContext)) {
      return { valid: false, reason: `question invents an unsupported expansion for ${match[2]}` };
    }
  }
  const quote = typeof question.source_quote === "string" ? question.source_quote.trim() : "";
  if (quote.split(/\s+/).length < 4 || !appearsIn(quote, source.text)) {
    return { valid: false, reason: "source_quote is not a verbatim uploaded-document excerpt" };
  }
  const answer: any = question.answer;

  if (expectedType === "mcq") {
    const options = stringArray(question.options);
    if (!options || options.length !== 4 || new Set(options.map(normalized)).size !== options.length) {
      return { valid: false, reason: "MCQ choices must be exactly 4 distinct strings" };
    }
    if (options.some((option) => /^(?:option|choice|answer)?\s*[a-d](?:[.):\-])?$/i.test(option.trim()) ||
        /^(?:option|choice|answer)\s+[a-d]\b/i.test(option.trim()))) {
      return { valid: false, reason: "MCQ choices must contain real answer text, not labels or placeholders" };
    }
    if (options.some((option) => option.split(/\s+/).length > 30 ||
        /[{}\[\]]|\b(?:querying|correct (?:answer|option)|should be selected|json|prompt)\b/i.test(option))) {
      return { valid: false, reason: "MCQ choices must not contain model commentary or serialization artifacts" };
    }
    if (Array.isArray(answer?.correct_indices)) {
      return { valid: false, reason: "MCQ must have exactly one correct_index, not correct_indices" };
    }
    if (!answer || !Number.isInteger(answer?.correct_index)) {
      return { valid: false, reason: "MCQ answer must include exactly one correct_index" };
    }
    const selectedIndices = [answer.correct_index];
    if (!Array.isArray(selectedIndices) || selectedIndices.length === 0 ||
        selectedIndices.some((idx) => !Number.isInteger(idx) || idx < 0 || idx >= options.length)) {
      return { valid: false, reason: "MCQ correct_index is invalid" };
    }
    if (new Set(selectedIndices).size !== selectedIndices.length) {
      return { valid: false, reason: "MCQ correct_index must be distinct" };
    }
    if (selectedIndices.length >= options.length) {
      return { valid: false, reason: "MCQ must have at least one distractor" };
    }
    if (question.source_fact) {
      const factTokens = meaningfulTokens(question.source_fact);
      const itemTokens = meaningfulTokens(`${question.prompt} ${selectedIndices.map((idx) => options[idx]).join(" ")}`);
      if (factTokens.size === 0 || ![...itemTokens].some((token) => factTokens.has(token))) {
        return { valid: false, reason: "MCQ is not meaningfully connected to its validated source fact" };
      }
    }
  } else if (expectedType === "true_false") {
    if (!answer || typeof answer.correct !== "boolean") {
      return { valid: false, reason: "true/false answer must be boolean" };
    }
    if (question.options != null) {
      const options = stringArray(question.options);
      if (!options || options.length !== 2 || normalized(options[0]) !== "true" || normalized(options[1]) !== "false") {
        return { valid: false, reason: "true/false choices must be [True, False]" };
      }
    }
  } else if (expectedType === "fill_blank") {
    // A fill-in-the-blank with no blank is really a short-answer question, and
    // the student UI renders no gap to complete.
    if (!/_{3,}/.test(question.prompt)) {
      return { valid: false, reason: "fill-blank prompt must contain a _____ blank" };
    }
    const accepted = stringArray(answer?.accepted);
    if (!accepted || accepted.some((value) => !appearsIn(value, source.text))) {
      return { valid: false, reason: "every accepted answer must occur in the selected source text" };
    }
    if (!accepted.some((value) => appearsIn(value, quote))) {
      return { valid: false, reason: "at least one accepted answer must appear in its evidence quote" };
    }
    // The blank answer must be concise. Allow one word, a short phrase, or a number.
    if (accepted.some((value) => {
      const trimmed = value.trim();
      if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return false;
      return trimmed.split(/\s+/).length > 5;
    })) {
      return { valid: false, reason: "a fill-blank answer must be a single word, a short phrase, or a number" };
    }
  } else if (expectedType === "matching") {
    const options: any = question.options;
    const left = stringArray(options?.left);
    const right = stringArray(options?.right);
    const pairs = answer?.pairs;
    if (!left || !right || left.length !== right.length || !Array.isArray(pairs) || pairs.length !== left.length) {
      return { valid: false, reason: "matching items or answer pairs are invalid" };
    }
    if ([...left, ...right].some((value) => !appearsIn(value, source.text))) {
      return { valid: false, reason: "every matching item must occur in its cited document chunk" };
    }
    // Column A items are the key terms. Reject extraction debris:
    // bare function words ("This"), and PDF layout artifacts ("... PAGE 12").
    const FUNCTION_WORD = /^(?:this|that|these|those|the|a|an|it|its|and|or|for|with|from|each|such|then|when|which|there|here|where|what|how|why|who|is|are|was|were|be|of|in|on|at|to|by|as|if|but|not)$/i;
    if (left.some((value) => {
      const term = value.trim();
      return term.length < 3 || FUNCTION_WORD.test(term) || /\bpage\b\s*\d*$/i.test(term);
    })) {
      return { valid: false, reason: "matching terms must be real concepts, not stray words or layout artifacts" };
    }
    if (right.some((value) => value.trim().split(/\s+/).length < 3)) {
      return { valid: false, reason: "matching responses must be definition-style statements" };
    }
    const usedLeft = new Set<number>();
    const usedRight = new Set<number>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || !Number.isInteger(pair[1]) ||
          pair[0] < 0 || pair[0] >= left.length || pair[1] < 0 || pair[1] >= right.length ||
          usedLeft.has(pair[0]) || usedRight.has(pair[1])) {
        return { valid: false, reason: "matching pairs must form a valid one-to-one mapping" };
      }
      if (normalized(right[pair[1]]).includes(normalized(left[pair[0]]))) {
        return { valid: false, reason: "a matching definition must not contain the term it matches" };
      }
      usedLeft.add(pair[0]);
      usedRight.add(pair[1]);
    }
  } else if (expectedType === "essay") {
    if (!answer || typeof answer.rubric !== "string" || answer.rubric.trim().length < 8) {
      return { valid: false, reason: "essay rubric is missing" };
    }
  } else {
    return { valid: false, reason: `unsupported question type: ${expectedType}` };
  }

  return { valid: true, source, sourceQuote: quote };
}
