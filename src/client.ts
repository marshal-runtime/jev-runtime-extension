import type {
  JevAskOptions,
  JevAskRequest,
  JevAskResult,
  JevClient,
  JevConnectionState,
  JevModelCard,
  JevStatus,
} from "./api.js";
import { DEFAULT_JEV_API_BASE_URL, DEFAULT_JEV_MODEL, JEV_CLIENT_SERVICE_VERSION } from "./api.js";
import type { KeyStore } from "./credentials.js";
import {
  abortedError,
  badRequestError,
  invalidKeyError,
  invalidResponseError,
  notConnectedError,
  permissionDeniedError,
  rateLimitedError,
  unavailableError,
} from "./errors.js";
import type { JevFetch } from "./transport.js";
import { getJsonWithRetry, isAbortError, postJsonWithRetry } from "./transport.js";
import { validateAnswer } from "./validation.js";

export interface CreateJevClientOptions {
  readonly keyStore: KeyStore;
  readonly fetchImpl: JevFetch;
  /** Injectable for tests; defaults to `process.env`. Only `TYPESAFE_API_KEY` is ever read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly defaultModel?: string;
  readonly apiBaseUrl?: string;
  readonly now?: () => Date;
}

export interface JevClientHandle {
  readonly client: JevClient;
  /** Verifies the candidate key against GET /v1/models BEFORE persisting; throws on failure, never stores a bad key. */
  saveKey(key: string): Promise<JevStatus>;
  /** Re-verifies the currently active key (stored or env) and updates cached status. */
  testConnection(): Promise<JevStatus>;
  /** Clears the stored key only; an env-supplied key remains active. */
  disconnect(): Promise<void>;
}

interface ResolvedKey {
  readonly key: string;
  readonly source: "stored" | "env";
}

interface KnownError {
  readonly state: Extract<JevConnectionState, "invalid-key" | "rate-limited" | "unavailable">;
  readonly detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createJevClient(options: CreateJevClientOptions): JevClientHandle {
  const { keyStore, fetchImpl } = options;
  const env = options.env ?? process.env;
  const defaultModel = options.defaultModel ?? DEFAULT_JEV_MODEL;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_JEV_API_BASE_URL).replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());

  let lastError: KnownError | undefined;
  let lastVerifiedAt: string | undefined;

  async function resolveKey(): Promise<ResolvedKey | undefined> {
    const stored = await keyStore.getKey();
    if (stored) return { key: stored, source: "stored" };
    const envKey = env.TYPESAFE_API_KEY;
    if (envKey) return { key: envKey, source: "env" };
    return undefined;
  }

  /** Maps a non-2xx TypeSafe HTTP status to a typed error, recording the connection-affecting ones for `status()`. */
  function mapHttpError(status: number, body: unknown, recordState: boolean) {
    const detail = isRecord(body) && isRecord(body.detail) ? body.detail : undefined;
    const message =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : detail && typeof detail.message === "string"
          ? detail.message
          : undefined;
    // TypeSafe answers a bad key with 403 + detail.error_type "authentication_error".
    if (status === 401 || (status === 403 && detail?.error_type === "authentication_error")) {
      if (recordState) lastError = { state: "invalid-key", detail: message };
      return invalidKeyError(message);
    }
    if (status === 403) {
      if (recordState) lastError = { state: "invalid-key", detail: message ?? "Permission denied." };
      return permissionDeniedError(message);
    }
    if (status === 429) {
      if (recordState) lastError = { state: "rate-limited", detail: message };
      return rateLimitedError(message);
    }
    if (status >= 500 || status === 529) {
      if (recordState) lastError = { state: "unavailable", detail: message };
      return unavailableError(status, message);
    }
    return badRequestError(message ?? `TypeSafe rejected the request (HTTP ${status}).`, status);
  }

  async function status(): Promise<JevStatus> {
    const resolved = await resolveKey();
    if (!resolved) return { state: "not-connected", model: defaultModel };
    if (lastError) {
      return {
        state: lastError.state,
        model: defaultModel,
        source: resolved.source,
        ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
        ...(lastError.detail ? { detail: lastError.detail } : {}),
      };
    }
    return {
      state: "connected",
      model: defaultModel,
      source: resolved.source,
      ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    };
  }

  async function ask(request: JevAskRequest, askOptions: JevAskOptions = {}): Promise<JevAskResult> {
    const resolved = await resolveKey();
    if (!resolved) throw notConnectedError();
    const model = request.model ?? defaultModel;
    const startedAt = Date.now();
    let response: Awaited<ReturnType<typeof postJsonWithRetry>>;
    try {
      response = await postJsonWithRetry(
        fetchImpl,
        `${apiBaseUrl}/v1/systemone`,
        resolved.key,
        { model, state: request.state, questions: request.questions },
        { signal: askOptions.signal, timeoutMs: askOptions.timeoutMs },
      );
    } catch (error) {
      if (isAbortError(error)) throw abortedError();
      lastError = { state: "unavailable", detail: error instanceof Error ? error.message : undefined };
      throw unavailableError(undefined, "Could not reach TypeSafe's Jev API.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpError(response.status, response.body, true);
    }
    if (!isRecord(response.body) || !isRecord(response.body.answers) || typeof response.body.model !== "string") {
      throw invalidResponseError("Jev returned a malformed /v1/systemone response.");
    }
    const rawAnswers = response.body.answers;
    const answers: Record<string, ReturnType<typeof validateAnswer>> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      answers[name] = validateAnswer(name, question, rawAnswers[name]);
    }
    const usage = isRecord(response.body.usage) ? response.body.usage : {};
    lastError = undefined;
    lastVerifiedAt = now().toISOString();
    return {
      answers,
      model: response.body.model,
      usage: {
        input_tokens: nonNegativeNumber(usage.input_tokens),
        output_tokens: nonNegativeNumber(usage.output_tokens),
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Shared by `listModels()` and the internal verify-before-save/test paths — never records state when `recordState` is false. */
  async function fetchModels(key: string, recordState: boolean): Promise<readonly JevModelCard[]> {
    let response: Awaited<ReturnType<typeof getJsonWithRetry>>;
    try {
      response = await getJsonWithRetry(fetchImpl, `${apiBaseUrl}/v1/models`, key);
    } catch (error) {
      if (isAbortError(error)) throw abortedError();
      if (recordState) lastError = { state: "unavailable", detail: error instanceof Error ? error.message : undefined };
      throw unavailableError(undefined, "Could not reach TypeSafe's Jev API.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpError(response.status, response.body, recordState);
    }
    const list = Array.isArray(response.body)
      ? response.body
      : isRecord(response.body) && Array.isArray(response.body.models)
        ? response.body.models
        : isRecord(response.body) && Array.isArray(response.body.data)
          ? response.body.data
          : undefined;
    if (!list) throw invalidResponseError("Jev returned a malformed /v1/models response.");
    const cards: JevModelCard[] = [];
    for (const entry of list) {
      if (isRecord(entry) && typeof entry.name === "string") {
        cards.push({
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          release_date: typeof entry.release_date === "string" ? entry.release_date : "",
        });
      }
    }
    if (recordState) {
      lastError = undefined;
      lastVerifiedAt = now().toISOString();
    }
    return cards;
  }

  async function listModels(): Promise<readonly JevModelCard[]> {
    const resolved = await resolveKey();
    if (!resolved) throw notConnectedError();
    return fetchModels(resolved.key, true);
  }

  async function saveKey(key: string): Promise<JevStatus> {
    const trimmed = key.trim();
    if (!trimmed) throw badRequestError("The API key must not be empty.");
    // Verify BEFORE persisting: never store a key that TypeSafe rejects.
    await fetchModels(trimmed, false);
    // `keyStore.setKey` throws `SecretsUnavailableError` (never falls back to
    // plaintext) when sealing isn't available — propagated as-is so the
    // connection card can show an honest "secure storage unavailable" error.
    await keyStore.setKey(trimmed);
    lastError = undefined;
    lastVerifiedAt = now().toISOString();
    return status();
  }

  async function testConnection(): Promise<JevStatus> {
    const resolved = await resolveKey();
    if (!resolved) return status();
    try {
      await fetchModels(resolved.key, true);
    } catch {
      // fetchModels already recorded lastError; status() below reflects it.
    }
    return status();
  }

  async function disconnect(): Promise<void> {
    keyStore.clear();
    lastError = undefined;
    lastVerifiedAt = undefined;
  }

  const client: JevClient = {
    version: JEV_CLIENT_SERVICE_VERSION,
    status,
    ask,
    listModels,
  };

  return { client, saveKey, testConnection, disconnect };
}
