/**
 * HTTP transport for TypeSafe's Jev API. Retry-on-status logic mirrors
 * Browser Use's jev-ultrafast reference client (`jev_ultrafast/model.py::
 * post_json`, MIT) — see README.md for attribution: retry up to twice
 * (three attempts total) on 429/503/529 with `0.5 * 2**attempt` second
 * backoff; a network-level failure (DNS, connection refused, timeout) is
 * never retried, only propagated.
 */

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonHttpResult {
  readonly status: number;
  readonly body: unknown;
}

const RETRYABLE_STATUSES = new Set([429, 503, 529]);
/** Initial attempt plus two retries, matching `range(3)` in the Python original. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface HttpCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to a real timer-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combinedSignal(options: HttpCallOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** `POST` with the Jev retry policy. Never retries a thrown network error — only a retryable HTTP status. */
export async function postJsonWithRetry(
  fetchImpl: JevFetch,
  url: string,
  apiKey: string,
  body: unknown,
  options: HttpCallOptions = {},
): Promise<JsonHttpResult> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(combinedSignal(options) ? { signal: combinedSignal(options) } : {}),
    });
    if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    return { status: response.status, body: await parseJsonBody(response) };
  }
  // Unreachable: the loop always returns on its final iteration.
  throw new Error("postJsonWithRetry exhausted attempts without returning.");
}

/** `GET` with the same retry policy (used by listModels()). */
export async function getJsonWithRetry(
  fetchImpl: JevFetch,
  url: string,
  apiKey: string,
  options: HttpCallOptions = {},
): Promise<JsonHttpResult> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(combinedSignal(options) ? { signal: combinedSignal(options) } : {}),
    });
    if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    return { status: response.status, body: await parseJsonBody(response) };
  }
  throw new Error("getJsonWithRetry exhausted attempts without returning.");
}

/** Real global-`fetch`-backed adapter — production wiring only; every test injects a fake. */
export function nodeFetch(): JevFetch {
  return (url, init) => fetch(url, init);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
