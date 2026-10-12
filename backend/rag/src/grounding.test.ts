import assert from "node:assert/strict";
import test from "node:test";
import { deriveEvidenceQuote, validateGroundedQuestion } from "./grounding.js";

const sources = [{
  document_id: "doc-1",
  text: "Photosynthesis occurs in the chloroplast. Chlorophyll absorbs red light and blue light. Mitochondria release energy from food. Stomata regulate gas exchange. ATP (adenosine triphosphate) stores energy in cells. The planet Mars is the fourth planet from the Sun.",
}];

test("accepts an MCQ whose choices and correct answer are grounded", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Where does photosynthesis occur?",
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, true);
  assert.equal(result.source?.document_id, "doc-1");
});

test("accepts naturally phrased MCQ options grounded in document terminology", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Which structure is responsible for photosynthesis?",
    options: [
      "The chloroplast",
      "Energy-releasing mitochondria",
      "Light-absorbing chlorophyll",
      "Gas-regulating stomata",
    ],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, true);
});

test("rejects MCQs with multiple correct answers", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Which structure is found in plant cells?",
    options: ["chloroplast", "mitochondria", "ribosome", "cell wall"],
    answer: { correct_indices: [0, 3] },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /correct_index/);
});

test("rejects non-English MCQ prompts", () => {
  const result = validateGroundedQuestion({
    type: "mcq", prompt: "¿Cuál es la respuesta correcta?",
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"],
    answer: { correct_index: 0 }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /English/);
});

test("rejects placeholder MCQ choices", () => {
  const result = validateGroundedQuestion({
    type: "mcq", prompt: "Where does photosynthesis occur?",
    options: ["option A", "option B", "option C", "option D"],
    answer: { correct_index: 0 }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /placeholders/);
});

test("rejects commentary embedded in MCQ choices", () => {
  const result = validateGroundedQuestion({
    type: "mcq", prompt: "Where does photosynthesis occur?",
    options: ["chloroplast", "Mitochondria", "The correct option should be selected here", "Stomata"],
    answer: { correct_index: 0 }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /commentary/);
});

test("rejects invented acronym expansions", () => {
  const result = validateGroundedQuestion({
    type: "mcq", prompt: "What does the Photosynthesis System (PS) produce?",
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"],
    answer: { correct_index: 0 }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /unsupported expansion/);
});

test("rejects a quote not copied from an uploaded chunk", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank",
    prompt: "Photosynthesis occurs in the ____.",
    answer: { accepted: ["chloroplast"] },
    source_index: 1,
    source_quote: "Plants perform this process inside a chloroplast.",
  }, "fill_blank", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /verbatim/);
});

test("derives verbatim evidence using the declared correct choice", () => {
  const quote = deriveEvidenceQuote({
    prompt: "Where does photosynthesis occur?",
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"],
    answer: { correct_index: 0 },
  }, "mcq", sources[0].text);
  assert.equal(quote, "Photosynthesis occurs in the chloroplast.");
});

test("rejects document-referential question wording", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "According to the uploaded document, where does photosynthesis occur?",
    options: ["chloroplast", "Mitochondria"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /must not refer/);
});

test("rejects templated sentence-completion wording", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Which statement completes the sentence about photosynthesis?",
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /prohibited/);
});

test("rejects overly long question wording", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: Array(75).fill("photosynthesis").join(" "),
    options: ["chloroplast", "Mitochondria", "Chlorophyll", "Stomata"], answer: { correct_index: 0 },
    source_index: 1, source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /too long/);
});

test("allows a concise generic matching instruction when every pair is grounded", () => {
  const result = validateGroundedQuestion({
    type: "matching", prompt: "Directions: Match the key terms in Column A with their correct definitions in Column B.",
    options: {
      left: ["Photosynthesis", "Stomata"],
      right: ["regulate gas exchange", "occurs in the chloroplast"],
    },
    answer: { pairs: [[0, 1], [1, 0]] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "matching", sources);
  assert.equal(result.valid, true);
});

test("rejects a matching statement that names the term it matches", () => {
  const result = validateGroundedQuestion({
    type: "matching", prompt: "Directions: Match the key terms in Column A with their correct definitions in Column B.",
    options: {
      left: ["Photosynthesis", "Stomata"],
      // The first statement gives its own answer away.
      right: ["Photosynthesis occurs in the chloroplast", "regulate gas exchange"],
    },
    answer: { pairs: [[0, 0], [1, 1]] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "matching", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /must not contain the term/);
});

test("rejects matching pairs that are not one-to-one", () => {
  const result = validateGroundedQuestion({
    type: "matching", prompt: "Directions: Match the key terms in Column A with their correct definitions in Column B.",
    options: {
      left: ["Photosynthesis", "Stomata"],
      right: ["regulate gas exchange", "occurs in the chloroplast"],
    },
    // Both terms claim the same definition.
    answer: { pairs: [[0, 1], [1, 1]] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "matching", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /one-to-one/);
});

test("rejects matching questions with extra definitions", () => {
  const result = validateGroundedQuestion({
    type: "matching", prompt: "Directions: Match the key terms in Column A with their correct definitions in Column B.",
    options: {
      left: ["Photosynthesis", "Stomata"],
      right: ["regulate gas exchange", "occurs in the chloroplast", "release energy from food"],
    },
    answer: { pairs: [[0, 1], [1, 0]] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "matching", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /matching items/);
});

test("rejects a true/false answer that is not boolean", () => {
  const result = validateGroundedQuestion({
    type: "true_false", prompt: "Chlorophyll absorbs red light and blue light.",
    options: ["True", "False"],
    answer: { correct: "yes" } as any, source_index: 1,
    source_quote: "Chlorophyll absorbs red light and blue light.",
  }, "true_false", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /boolean/);
});

test("rejects an essay question with no rubric", () => {
  const result = validateGroundedQuestion({
    type: "essay", prompt: "Explain how chlorophyll contributes to photosynthesis.",
    answer: {}, source_index: 1,
    source_quote: "Chlorophyll absorbs red light and blue light.",
  }, "essay", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /rubric/);
});

test("accepts a fill-blank whose accepted answer appears in the evidence quote", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank", prompt: "Fill in the blank: Photosynthesis occurs in the _____.",
    answer: { accepted: ["chloroplast"] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "fill_blank", sources);
  assert.equal(result.valid, true);
});

test("accepts a fill-blank with multiple accepted answers", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank", prompt: "Fill in the blank: ATP is also called _____.",
    answer: { accepted: ["ATP", "adenosine triphosphate"] }, source_index: 1,
    source_quote: "ATP (adenosine triphosphate) stores energy in cells.",
  }, "fill_blank", sources);
  assert.equal(result.valid, true);
});

test("rejects a fill-blank prompt that has no blank to complete", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank", prompt: "Where does photosynthesis occur?",
    answer: { accepted: ["chloroplast"] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "fill_blank", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /must contain a _____ blank/);
});

test("rejects a fill-blank answer that restates a whole sentence", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank", prompt: "Fill in the blank: _____",
    answer: { accepted: ["Chlorophyll absorbs red light and blue light. Mitochondria release energy from food."] },
    source_index: 1,
    source_quote: "Chlorophyll absorbs red light and blue light. Mitochondria release energy from food.",
  }, "fill_blank", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /single word, a short phrase, or a number/);
});

test("accepts a fill-blank answer that is a number", () => {
  const result = validateGroundedQuestion({
    type: "fill_blank", prompt: "Fill in the blank: The planet Mars is the _____ planet from the Sun.",
    answer: { accepted: ["fourth"] },
    source_index: 1,
    source_quote: "The planet Mars is the fourth planet from the Sun.",
  }, "fill_blank", sources);
  assert.equal(result.valid, true);
});

test("rejects matching terms that are stray function words", () => {
  const result = validateGroundedQuestion({
    type: "matching", prompt: "Directions: Match the key terms in Column A with their correct definitions in Column B.",
    options: {
      // "The" is extraction debris, not a concept a student can match.
      left: ["The", "Stomata"],
      right: ["regulate gas exchange", "occurs in the chloroplast"],
    },
    answer: { pairs: [[0, 1], [1, 0]] }, source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "matching", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /real concepts/);
});
