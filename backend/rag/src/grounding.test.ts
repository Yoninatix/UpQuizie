import assert from "node:assert/strict";
import test from "node:test";
import { deriveEvidenceQuote, validateGroundedQuestion } from "./grounding.js";

const sources = [{
  document_id: "doc-1",
  text: "Photosynthesis occurs in the chloroplast. Chlorophyll absorbs red light and blue light. Mitochondria release energy from food.",
}];

test("accepts an MCQ whose choices and correct answer are grounded", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Where does photosynthesis occur?",
    options: ["chloroplast", "Mitochondria"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, true);
  assert.equal(result.source?.document_id, "doc-1");
});

test("rejects a fabricated distractor", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Where does photosynthesis occur?",
    options: ["chloroplast", "Golgi apparatus"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /every MCQ choice/);
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
    options: ["chloroplast", "Mitochondria"],
    answer: { correct_index: 0 },
  }, "mcq", sources[0].text);
  assert.equal(quote, "Photosynthesis occurs in the chloroplast.");
});

test("rejects a question unrelated to its otherwise valid quote", () => {
  const result = validateGroundedQuestion({
    type: "mcq",
    prompt: "Which treaty ended the war?",
    options: ["chloroplast", "Mitochondria"],
    answer: { correct_index: 0 },
    source_index: 1,
    source_quote: "Photosynthesis occurs in the chloroplast.",
  }, "mcq", sources);
  assert.equal(result.valid, false);
  assert.match(result.reason || "", /substantive overlap/);
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
