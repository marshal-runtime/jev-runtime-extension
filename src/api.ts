/**
 * Public contract for @marshal/jev.
 *
 * This module is deliberately self-contained (no imports from unpublished
 * `@marshal/agent-runtime-*` packages, no imports from elsewhere in this
 * package's implementation): downstream extensions depend on @marshal/jev
 * for TYPES ONLY and resolve the live service instance by injection (Symbol
 * lookup), never by importing implementation code.
 *
 * The contract is the one TypeSafe's Jev "System One" API defined (validation
 * follows Browser Use's jev-ultrafast reference client, MIT — see README.md);
 * answers are now produced by OpenAI Chat Completions with Structured Outputs
 * (POST /v1/chat/completions, GET /v1/models) using the user's OpenAI key.
 */

// ---------------------------------------------------------------------------
// Service identity
// ---------------------------------------------------------------------------

export const JEV_CLIENT_SERVICE_ID = "@marshal/jev:client" as const;
export const JEV_CLIENT_SERVICE_VERSION = "1.0.0" as const;

/**
 * Versioned injection token. Consumers MUST re-resolve via this symbol on
 * every provider replacement rather than caching a client instance.
 */
export const JEV_CLIENT_SERVICE_TOKEN: symbol = Symbol.for(JEV_CLIENT_SERVICE_ID);

/** OpenAI model used when a request omits `model` or names a legacy TypeSafe `jev-*` model. */
export const DEFAULT_JEV_MODEL = "gpt-5-mini" as const;
export const DEFAULT_JEV_API_BASE_URL = "https://api.openai.com" as const;

// ---------------------------------------------------------------------------
// Questions (request)
// ---------------------------------------------------------------------------

export interface ChoiceQuestion {
  readonly type: "choice";
  /** option id -> arbitrary JSON description of that option. */
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly instructions?: unknown;
}

export interface ScoreQuestion {
  readonly type: "score";
  /** level (as a string key, "1".."10") -> description; 2-10 ordered levels. */
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly instructions?: unknown;
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly criteria?: Readonly<{ true?: unknown; false?: unknown }>;
  readonly instructions?: unknown;
}

export type JevQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

// ---------------------------------------------------------------------------
// Answers (response)
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  readonly type?: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly legend?: Readonly<Record<string, unknown>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

export interface JevAskRequest {
  readonly model?: string;
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[] | null;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface JevAskOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface JevAskResult {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly model: string;
  readonly usage: JevUsage;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface JevModelCard {
  readonly name: string;
  readonly description: string;
  readonly release_date: string;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type JevConnectionState =
  | "not-connected"
  | "connected"
  | "invalid-key"
  | "rate-limited"
  | "unavailable";

export interface JevStatus {
  readonly state: JevConnectionState;
  readonly model: string;
  /** Where the currently-active key came from; absent when not-connected. Never the key itself. */
  readonly source?: "env" | "stored";
  readonly lastVerifiedAt?: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type JevClientErrorCode =
  | "JEV_NOT_CONNECTED"
  | "JEV_INVALID_KEY"
  | "JEV_RATE_LIMITED"
  | "JEV_UNAVAILABLE"
  | "JEV_BAD_REQUEST"
  | "JEV_INVALID_RESPONSE"
  | "JEV_ABORTED";

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

export interface JevClient {
  readonly version: typeof JEV_CLIENT_SERVICE_VERSION;

  /** Never returns the key itself. */
  status(): Promise<JevStatus>;

  /**
   * Validates every choice/score/noul answer before resolving. Retries
   * 429/503/529 up to twice with backoff. Throws a `JevClientError` (see
   * `JevClientErrorCode`) on any failure — never returns a partially
   * validated result.
   */
  ask(request: JevAskRequest, options?: JevAskOptions): Promise<JevAskResult>;

  listModels(): Promise<readonly JevModelCard[]>;
}
