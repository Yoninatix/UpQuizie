// JSON Schema contracts for AI question generation. Kept in its own module so
// the schemas can be unit-tested without booting the Express server.

/**
 * Machine-enforced output contract per question type. Passing this to Ollama's
 * `format` constrains decoding itself, so the model cannot emit a missing
 * answer object, a wrong field name, or truncated/among-prose JSON — failures
 * that previously surfaced as "could not parse JSON" and burned whole batches.
 * Grounding rules (is the answer actually in the document?) are NOT expressible
 * here and remain the job of validateGroundedQuestion.
 */
export function jsonSchemaFor(type: string, difficulty: string, want: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: { type: "string", enum: [type] },
    difficulty: { type: "string", enum: [difficulty] },
    topic: { type: "string" },
    prompt: { type: "string", minLength: 8 },
  };
  let specific: Record<string, unknown>;
  switch (type) {
    case "true_false":
      specific = {
        options: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
        answer: {
          type: "object",
          properties: { correct: { type: "boolean" } },
          required: ["correct"],
        },
      };
      break;
    case "fill_blank":
      specific = {
        answer: {
          type: "object",
          properties: {
            accepted: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          },
          required: ["accepted"],
        },
      };
      break;
    case "matching":
      specific = {
        options: {
          type: "object",
          properties: {
            left: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1 } },
            right: { type: "array", minItems: 2, maxItems: 6, items: { type: "string", minLength: 1 } },
          },
          required: ["left", "right"],
        },
        answer: {
          type: "object",
          properties: {
            pairs: {
              type: "array", minItems: 2,
              items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer" } },
            },
          },
          required: ["pairs"],
        },
      };
      break;
    case "essay":
      specific = {
        answer: {
          type: "object",
          properties: { rubric: { type: "string", minLength: 8 } },
          required: ["rubric"],
        },
      };
      break;
    default:
      throw new Error(`unsupported question type: ${type}`);
  }
  const required = ["type", "difficulty", "topic", "prompt", "answer"];
  if (type === "matching") required.push("options");
  // toQuestionArray already unwraps { questions: [...] }, and a named array
  // property is the shape Ollama constrains most reliably.
  return {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: want,
        items: { type: "object", properties: { ...base, ...specific }, required },
      },
    },
    required: ["questions"],
  };
}

