import { describe, expect, it } from "vitest";
import { validateAnswer, validateChoiceAnswer, validateNoulAnswer, validateScoreAnswer } from "./validation.js";
import { JevClientError } from "./errors.js";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./api.js";

const OPTIONS = ["yes", "no", "maybe"];

function choiceAnswer(overrides: Record<string, unknown> = {}) {
  return {
    choice: "yes",
    probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 },
    confidence: 0.7,
    ...overrides,
  };
}

describe("validateChoiceAnswer", () => {
  it("accepts a well-formed answer", () => {
    const answer = validateChoiceAnswer(choiceAnswer(), OPTIONS);
    expect(answer).toEqual({
      type: "choice",
      choice: "yes",
      probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 },
      confidence: 0.7,
    });
  });

  it("rejects a choice not in the offered options", () => {
    expect(() => validateChoiceAnswer(choiceAnswer({ choice: "banana" }), OPTIONS)).toThrow(JevClientError);
  });

  it("rejects when the probability key set does not match the options", () => {
    expect(() =>
      validateChoiceAnswer(choiceAnswer({ probabilities: { yes: 0.7, no: 0.3 } }), OPTIONS),
    ).toThrow(JevClientError);
  });

  it("rejects when the probability key set has an extra key", () => {
    expect(() =>
      validateChoiceAnswer(choiceAnswer({ probabilities: { yes: 0.5, no: 0.2, maybe: 0.1, extra: 0.2 } }), OPTIONS),
    ).toThrow(JevClientError);
  });

  it("rejects when probabilities do not sum to ~1", () => {
    expect(() =>
      validateChoiceAnswer(choiceAnswer({ probabilities: { yes: 0.1, no: 0.1, maybe: 0.1 } }), OPTIONS),
    ).toThrow(JevClientError);
  });

  it("accepts a sum within the 0.02 tolerance", () => {
    const answer = validateChoiceAnswer(
      choiceAnswer({ probabilities: { yes: 0.69, no: 0.2, maybe: 0.1 } }),
      OPTIONS,
    );
    expect(answer.choice).toBe("yes");
  });

  it("rejects when the chosen option is not the argmax", () => {
    expect(() =>
      validateChoiceAnswer(choiceAnswer({ choice: "no", probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 } }), OPTIONS),
    ).toThrow(JevClientError);
  });

  it("rejects a non-finite or out-of-range confidence", () => {
    expect(() => validateChoiceAnswer(choiceAnswer({ confidence: Number.POSITIVE_INFINITY }), OPTIONS)).toThrow(
      JevClientError,
    );
    expect(() => validateChoiceAnswer(choiceAnswer({ confidence: 1.5 }), OPTIONS)).toThrow(JevClientError);
  });

  it("rejects a malformed (non-object) answer", () => {
    expect(() => validateChoiceAnswer(null, OPTIONS)).toThrow(JevClientError);
    expect(() => validateChoiceAnswer("yes", OPTIONS)).toThrow(JevClientError);
  });
});

describe("validateNoulAnswer", () => {
  it("accepts a noul value in [0, 1]", () => {
    expect(validateNoulAnswer({ noul: 0.42 })).toEqual({ type: "noul", noul: 0.42 });
    expect(validateNoulAnswer({ noul: 0 })).toEqual({ type: "noul", noul: 0 });
    expect(validateNoulAnswer({ noul: 1 })).toEqual({ type: "noul", noul: 1 });
  });

  it("rejects a noul value outside [0, 1]", () => {
    expect(() => validateNoulAnswer({ noul: 1.01 })).toThrow(JevClientError);
    expect(() => validateNoulAnswer({ noul: -0.01 })).toThrow(JevClientError);
  });

  it("rejects a non-finite or missing noul value", () => {
    expect(() => validateNoulAnswer({ noul: Number.NaN })).toThrow(JevClientError);
    expect(() => validateNoulAnswer({})).toThrow(JevClientError);
    expect(() => validateNoulAnswer(null)).toThrow(JevClientError);
  });
});

describe("validateScoreAnswer (structural passthrough)", () => {
  it("accepts a bounded score with probabilities and confidence", () => {
    const raw = { score: 7, probabilities: { "1": 0.05, "7": 0.6, "10": 0.35 }, confidence: 0.6, legend: { "7": "good" } };
    expect(validateScoreAnswer(raw)).toEqual({ type: "score", ...raw });
  });

  it("passes through without a legend when absent", () => {
    const raw = { score: 3, probabilities: { "3": 1 }, confidence: 0.9 };
    expect(validateScoreAnswer(raw)).toEqual({ type: "score", ...raw });
  });

  it("rejects a non-finite score or confidence", () => {
    expect(() => validateScoreAnswer({ score: Number.NaN, probabilities: {}, confidence: 0.5 })).toThrow(JevClientError);
    expect(() => validateScoreAnswer({ score: 5, probabilities: {}, confidence: 2 })).toThrow(JevClientError);
  });

  it("rejects an out-of-range probability value", () => {
    expect(() => validateScoreAnswer({ score: 5, probabilities: { "5": 1.5 }, confidence: 0.5 })).toThrow(JevClientError);
  });
});

describe("validateAnswer dispatch", () => {
  it("dispatches choice questions to strict validation", () => {
    const question: ChoiceQuestion = { type: "choice", criteria: { yes: "Yes", no: "No", maybe: "Maybe" } };
    const answer = validateAnswer("q1", question, choiceAnswer());
    expect(answer.type).toBe("choice");
  });

  it("dispatches score questions to structural validation", () => {
    const question: ScoreQuestion = { type: "score", criteria: { "1": "low", "10": "high" } };
    const answer = validateAnswer("q2", question, { score: 8, probabilities: { "1": 0.1, "10": 0.9 }, confidence: 0.8 });
    expect(answer).toMatchObject({ type: "score", score: 8 });
  });

  it("dispatches noul questions to range validation", () => {
    const question: NoulQuestion = { type: "noul" };
    const answer = validateAnswer("q3", question, { noul: 0.3 });
    expect(answer).toEqual({ type: "noul", noul: 0.3 });
  });

  it("wraps failures with the question name for context", () => {
    const question: ChoiceQuestion = { type: "choice", criteria: { yes: "Yes" } };
    expect(() => validateAnswer("operation", question, { choice: "nope" })).toThrow(/operation/);
  });
});
