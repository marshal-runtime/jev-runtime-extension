/**
 * Answer validation, ported from Browser Use's jev-ultrafast reference
 * client (`jev_ultrafast/model.py::validate_choice`, MIT license) — see
 * README.md for attribution. The Python original validates only "choice"
 * answers (Jev's browser-automation client only ever asks choice questions);
 * this port keeps that exact logic for `choice` and extends the same
 * finite-probability-mass reasoning to `noul` (a single probability in
 * [0, 1]). `score` answers are passed through structurally (bounded numbers)
 * without an argmax check, matching TypeSafe's own contract for score
 * questions (a numeric level, not a discrete choice).
 */

import type { ChoiceAnswer, JevAnswer, JevQuestion, NoulAnswer, ScoreAnswer } from "./api.js";
import { invalidResponseError } from "./errors.js";

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exact structural port of `validate_choice` (model.py:30-45): the chosen
 * option must be one of the offered ids, the probability map's key set must
 * exactly equal the offered ids, every probability plus `confidence` must be
 * a finite number in [0, 1], the probabilities must sum to ~1 (tolerance
 * 0.02, same as the Python original), and the chosen option's probability
 * must be the (near-)maximum (tolerance 1e-6, same as the Python original).
 */
export function validateChoiceAnswer(answer: unknown, optionIds: readonly string[]): ChoiceAnswer {
  const ids = new Set(optionIds);
  const fail = (): never => {
    throw invalidResponseError("Invalid Jev choice response; the answer did not match the offered options.");
  };
  if (!isRecord(answer)) fail();
  const record = answer as Record<string, unknown>;
  if (typeof record.choice !== "string" || !ids.has(record.choice)) fail();
  const choice: string = record.choice as string;
  if (!isRecord(record.probabilities)) fail();
  const probabilities = record.probabilities as Record<string, unknown>;
  const probabilityKeys = Object.keys(probabilities);
  if (probabilityKeys.length !== ids.size || probabilityKeys.some((key) => !ids.has(key))) fail();
  const values = Object.values(probabilities);
  if (!isFiniteNumberInRange(record.confidence, 0, 1)) fail();
  if (values.some((value) => !isFiniteNumberInRange(value, 0, 1))) fail();
  const numericValues = values as number[];
  const sum = numericValues.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) >= 0.02) fail();
  const chosenProbability = probabilities[choice] as number;
  const maxProbability = Math.max(...numericValues);
  if (chosenProbability < maxProbability - 1e-6) fail();
  return {
    type: "choice",
    choice,
    probabilities: probabilities as Record<string, number>,
    confidence: record.confidence as number,
  };
}

/** `noul` must be a single finite probability in [0, 1]. */
export function validateNoulAnswer(answer: unknown): NoulAnswer {
  if (!isRecord(answer) || !isFiniteNumberInRange(answer.noul, 0, 1)) {
    throw invalidResponseError("Invalid Jev noul response; expected a finite value in [0, 1].");
  }
  return { type: "noul", noul: answer.noul };
}

/**
 * Structural passthrough: `score` must be a finite number, `probabilities`
 * (when present) must map to finite numbers in [0, 1], and `confidence` (when
 * present) must be finite in [0, 1]. No argmax check — a score answer names a
 * level, not a discrete choice, so there is nothing to compare it against.
 */
export function validateScoreAnswer(answer: unknown): ScoreAnswer {
  const fail = (): never => {
    throw invalidResponseError("Invalid Jev score response; expected a bounded numeric score.");
  };
  if (!isRecord(answer)) fail();
  const record = answer as Record<string, unknown>;
  if (typeof record.score !== "number" || !Number.isFinite(record.score)) fail();
  if (!isFiniteNumberInRange(record.confidence, 0, 1)) fail();
  if (!isRecord(record.probabilities)) fail();
  const probabilities = record.probabilities as Record<string, unknown>;
  if (Object.values(probabilities).some((value) => !isFiniteNumberInRange(value, 0, 1))) fail();
  return {
    type: "score",
    score: record.score as number,
    probabilities: probabilities as Record<string, number>,
    confidence: record.confidence as number,
    ...(isRecord(record.legend) ? { legend: record.legend } : {}),
  };
}

/** Dispatches on the request question's declared `type` to the matching validator above. */
export function validateAnswer(name: string, question: JevQuestion, answer: unknown): JevAnswer {
  try {
    if (question.type === "choice") return validateChoiceAnswer(answer, Object.keys(question.criteria));
    if (question.type === "score") return validateScoreAnswer(answer);
    return validateNoulAnswer(answer);
  } catch (error) {
    if (error instanceof Error) {
      throw invalidResponseError(`${error.message} (question "${name}")`);
    }
    throw error;
  }
}
