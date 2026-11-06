/**
 * OpenAI backend for the Jev contract. One structured-output Chat Completions
 * call answers every question in a request; this module builds that call and
 * converts the model's ranked candidates into Jev-shaped answers, which
 * `validation.ts` then checks exactly as it checked TypeSafe's answers.
 *
 * Choice and score questions are answered as a short ranking of the most
 * likely options (the automation extension offers hundreds of page elements
 * per question); every option the model did not rank gets probability 0 and
 * the ranked mass is renormalized to 1.
 */

import type { JevQuestion } from "./api.js";

const MAX_RANKED_OPTIONS = 5;
/** Structured Outputs caps a single enum; above this the option id is validated after the call instead. */
const MAX_ENUM_OPTIONS = 500;

const SYSTEM_PROMPT = [
  "You are Jev, a fast judgement model. You receive a JSON object with a `state` and named `questions`, and answer every question from the state alone.",
  "- choice: `criteria` maps option ids to descriptions. Return `ranking`: up to " +
    `${MAX_RANKED_OPTIONS} of the most likely option ids, most likely first, each with a probability; probabilities over all options sum to 1.`,
  "- score: `criteria` maps ordered levels to descriptions. Return `ranking` over those levels the same way.",
  "- noul: return `probability_true`, the probability in [0, 1] that the question's instructions or `criteria.true` hold for the state.",
  "Follow each question's `instructions`. Use only ids or levels that appear in that question's criteria.",
].join("\n");

export interface OpenAiChatRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
  readonly response_format: unknown;
  readonly temperature?: number;
  readonly reasoning_effort?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Older GPT-5 models accept `minimal`; newer reasoning models are left on their own default. */
export function defaultReasoningEffort(model: string): string | undefined {
  return /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(model) ? "minimal" : undefined;
}

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

function rankingSchema(ids: readonly string[]): Record<string, unknown> {
  const option = ids.length > 0 && ids.length <= MAX_ENUM_OPTIONS ? { type: "string", enum: ids } : { type: "string" };
  return {
    type: "object",
    properties: {
      ranking: {
        type: "array",
        items: {
          type: "object",
          properties: { option, probability: { type: "number" } },
          required: ["option", "probability"],
          additionalProperties: false,
        },
      },
    },
    required: ["ranking"],
    additionalProperties: false,
  };
}

function questionSchema(question: JevQuestion): Record<string, unknown> {
  if (question.type === "noul") {
    return {
      type: "object",
      properties: { probability_true: { type: "number" } },
      required: ["probability_true"],
      additionalProperties: false,
    };
  }
  return rankingSchema(Object.keys(question.criteria ?? {}));
}

export function buildChatRequest(
  model: string,
  state: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
  reasoningEffort: string | undefined,
): OpenAiChatRequest {
  const names = Object.keys(questions);
  const schema = {
    type: "object",
    properties: Object.fromEntries(names.map((name) => [name, questionSchema(questions[name])])),
    required: names,
    additionalProperties: false,
  };
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ state, questions }) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "jev_answers", strict: true, schema } },
    ...(isReasoningModel(model)
      ? reasoningEffort
        ? { reasoning_effort: reasoningEffort }
        : {}
      : { temperature: 0 }),
  };
}

/** Ranked candidates -> a full distribution over `ids`, or undefined when the ranking carries no usable mass. */
function distribution(ranking: unknown, ids: readonly string[]): Record<string, number> | undefined {
  if (!Array.isArray(ranking)) return undefined;
  const offered = new Set(ids);
  const mass: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const entry of ranking.slice(0, MAX_RANKED_OPTIONS)) {
    if (!isRecord(entry) || typeof entry.option !== "string" || !offered.has(entry.option)) continue;
    const probability = entry.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0) continue;
    mass[entry.option] += probability;
  }
  const total = Object.values(mass).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return undefined;
  for (const id of ids) mass[id] = mass[id] / total;
  return mass;
}

function argmax(probabilities: Record<string, number>): [string, number] {
  let best: [string, number] = ["", -1];
  for (const [id, value] of Object.entries(probabilities)) if (value > best[1]) best = [id, value];
  return best;
}

/**
 * Converts one parsed structured-output object into the Jev answer shapes.
 * Anything malformed is passed through as-is so `validateAnswer` rejects it
 * with the usual JEV_INVALID_RESPONSE error.
 */
export function toJevAnswers(
  questions: Readonly<Record<string, JevQuestion>>,
  output: unknown,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  if (!isRecord(output)) return answers;
  for (const [name, question] of Object.entries(questions)) {
    const raw = output[name];
    if (!isRecord(raw)) {
      answers[name] = raw;
      continue;
    }
    if (question.type === "noul") {
      answers[name] = { noul: raw.probability_true };
      continue;
    }
    const ids = Object.keys(question.criteria ?? {});
    const probabilities = distribution(raw.ranking, ids);
    if (!probabilities) {
      answers[name] = raw;
      continue;
    }
    const [best, confidence] = argmax(probabilities);
    answers[name] =
      question.type === "choice"
        ? { choice: best, probabilities, confidence }
        : { type: "score", score: Number(best), probabilities, confidence };
  }
  return answers;
}

export interface ParsedChatCompletion {
  readonly output: unknown;
  readonly model?: string;
  readonly usage: { readonly input_tokens: unknown; readonly output_tokens: unknown };
  readonly refusal?: string;
}

/** Undefined when the body is not a Chat Completions response at all. */
export function parseChatCompletion(body: unknown): ParsedChatCompletion | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return undefined;
  const message = body.choices[0].message;
  if (!isRecord(message)) return undefined;
  const usage = isRecord(body.usage) ? body.usage : {};
  const base = {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
  if (typeof message.refusal === "string" && message.refusal) return { ...base, output: undefined, refusal: message.refusal };
  if (typeof message.content !== "string") return undefined;
  try {
    return { ...base, output: JSON.parse(message.content) as unknown };
  } catch {
    return undefined;
  }
}

/** OpenAI's error envelope is `{ error: { message, type, code } }`. */
export function openAiErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.error === "string" ? body.error : undefined;
}
