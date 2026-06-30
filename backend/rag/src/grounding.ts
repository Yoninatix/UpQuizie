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
  const stop = new Set(["this", "that", "with", "from", "what", "which", "where", "when", "does", "have", "into", "true", "false"]);
  return new Set(normalized(value).replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length >= 4 && !stop.has(token)));
}

/** Selects an exact sentence from the uploaded chunk instead of trusting an LLM citation. */
export function deriveEvidenceQuote(question: GroundedQuestion, expectedType: string, sourceText: string): string {
  const answer: any = question.answer;
  const anchors: string[] = [];
  if (expectedType === "mcq" && Array.isArray(question.options) && Number.isInteger(answer?.correct_index)) {
    anchors.push(String(question.options[answer.correct_index] ?? ""));
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
  if (question.type && question.type !== expectedType) {
    return { valid: false, reason: `expected ${expectedType}, received ${question.type}` };
  }
  const sourceIndex = Number(question.source_index);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > sources.length) {
    return { valid: false, reason: "invalid source_index" };
  }
  const source = sources[sourceIndex - 1];
  const quote = typeof question.source_quote === "string" ? question.source_quote.trim() : "";
  if (quote.split(/\s+/).length < 4 || !appearsIn(quote, source.text)) {
    return { valid: false, reason: "source_quote is not a verbatim uploaded-document excerpt" };
  }
  const promptTokens = meaningfulTokens(question.prompt);
  const quoteTokens = meaningfulTokens(quote);
  if (expectedType !== "matching" && promptTokens.size > 0 && ![...promptTokens].some((token) => quoteTokens.has(token))) {
    return { valid: false, reason: "question has no substantive overlap with its evidence quote" };
  }

  const allContext = sources.map((s) => s.text).join("\n");
  const answer: any = question.answer;

  if (expectedType === "mcq") {
    const options = stringArray(question.options);
    if (!options || options.length < 2 || options.length > 6 || new Set(options.map(normalized)).size !== options.length) {
      return { valid: false, reason: "MCQ choices must be 2-6 distinct strings" };
    }
    if (!answer || !Number.isInteger(answer.correct_index) || answer.correct_index < 0 || answer.correct_index >= options.length) {
      return { valid: false, reason: "MCQ correct_index is invalid" };
    }
    if (options.some((option) => !appearsIn(option, allContext))) {
      return { valid: false, reason: "every MCQ choice must occur in the retrieved documents" };
    }
    if (!appearsIn(options[answer.correct_index], quote)) {
      return { valid: false, reason: "the correct MCQ choice must occur in its evidence quote" };
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
    const accepted = stringArray(answer?.accepted);
    if (!accepted || accepted.some((value) => !appearsIn(value, quote))) {
      return { valid: false, reason: "every accepted answer must occur in its evidence quote" };
    }
  } else if (expectedType === "matching") {
    const options: any = question.options;
    const left = stringArray(options?.left);
    const right = stringArray(options?.right);
    const pairs = answer?.pairs;
    if (!left || !right || !Array.isArray(pairs) || pairs.length !== left.length) {
      return { valid: false, reason: "matching items or answer pairs are invalid" };
    }
    if ([...left, ...right].some((value) => !appearsIn(value, source.text))) {
      return { valid: false, reason: "every matching item must occur in its cited document chunk" };
    }
    const usedLeft = new Set<number>();
    const usedRight = new Set<number>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || !Number.isInteger(pair[1]) ||
          pair[0] < 0 || pair[0] >= left.length || pair[1] < 0 || pair[1] >= right.length ||
          usedLeft.has(pair[0]) || usedRight.has(pair[1])) {
        return { valid: false, reason: "matching pairs must form a valid one-to-one mapping" };
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
