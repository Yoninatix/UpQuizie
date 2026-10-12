import assert from "node:assert/strict";
import test from "node:test";
import { jsonSchemaFor } from "./schema.js";

const TYPES = ["mcq", "true_false", "fill_blank", "matching", "essay"];

function itemSchema(type: string, want = 3): any {
  const root = jsonSchemaFor(type, "easy", want) as any;
  return root.properties.questions.items;
}

test("every supported type produces a questions-array envelope", () => {
  for (const type of TYPES) {
    const root = jsonSchemaFor(type, "easy", 4) as any;
    assert.equal(root.type, "object", `${type} root should be an object`);
    assert.deepEqual(root.required, ["questions"], `${type} must require questions`);
    assert.equal(root.properties.questions.type, "array");
    assert.equal(root.properties.questions.maxItems, 4, `${type} must cap at the requested count`);
  }
});

test("every type pins its own discriminator and difficulty", () => {
  for (const type of TYPES) {
    const item = itemSchema(type);
    assert.deepEqual(item.properties.type.enum, [type]);
    assert.deepEqual(item.properties.difficulty.enum, ["easy"]);
    for (const field of ["type", "difficulty", "topic", "prompt", "answer"]) {
      assert.ok(item.required.includes(field), `${type} must require ${field}`);
    }
  }
});

test("the schema is JSON-serializable for the Ollama format field", () => {
  for (const type of TYPES) {
    const root = jsonSchemaFor(type, "medium", 2);
    assert.deepEqual(JSON.parse(JSON.stringify(root)), root, `${type} must round-trip as JSON`);
  }
});

test("true_false requires a boolean answer", () => {
  const answer = itemSchema("true_false").properties.answer;
  assert.equal(answer.properties.correct.type, "boolean");
  assert.deepEqual(answer.required, ["correct"]);
});

test("mcq requires exactly one correct index", () => {
  const item = itemSchema("mcq");
  assert.ok(item.required.includes("options"), "mcq must require options");
  assert.equal(item.properties.options.minItems, 4);
  assert.equal(item.properties.options.maxItems, 4);
  const answer = item.properties.answer;
  assert.deepEqual(answer.required, ["correct_index"]);
  assert.ok(!("correct_indices" in answer.properties), "mcq must not allow multiple correct answers");
});

test("fill_blank requires at least one accepted answer string", () => {
  const accepted = itemSchema("fill_blank").properties.answer.properties.accepted;
  assert.equal(accepted.type, "array");
  assert.equal(accepted.minItems, 1);
  assert.equal(accepted.items.type, "string");
});

test("matching requires left/right lists and two-integer pairs", () => {
  const item = itemSchema("matching");
  assert.ok(item.required.includes("options"), "matching must require options");
  const options = item.properties.options;
  assert.equal(options.properties.left.minItems, 2);
  assert.equal(options.properties.right.minItems, 2);
  assert.equal(options.properties.left.maxItems, 5);
  assert.equal(options.properties.right.maxItems, 5);
  const pairs = item.properties.answer.properties.pairs;
  assert.equal(pairs.items.minItems, 2);
  assert.equal(pairs.items.maxItems, 2);
  assert.equal(pairs.items.items.type, "integer");
});

test("essay requires a non-trivial rubric", () => {
  const rubric = itemSchema("essay").properties.answer.properties.rubric;
  assert.equal(rubric.type, "string");
  assert.ok((rubric.minLength ?? 0) >= 8, "rubric should have a minimum length");
});

test("an unsupported type is rejected rather than silently unconstrained", () => {
  assert.throws(() => jsonSchemaFor("crossword", "easy", 3), /unsupported question type/);
});
