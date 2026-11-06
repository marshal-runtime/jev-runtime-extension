# @marshal/jev

Marshal Runtime extension providing the **Jev "System One"** contract (originally TypeSafe's): fast, validated `choice` / `score` / `noul` answers over an arbitrary JSON `state`, plus model discovery — now answered by **OpenAI** (Chat Completions with Structured Outputs) behind a sealed, per-machine OpenAI API key.

## How answers are produced

`ask()` sends one `POST /v1/chat/completions` call per request with a strict JSON schema covering every question. Choice and score questions come back as a ranking of up to five likely options; options the model did not rank get probability 0 and the ranked mass is renormalized, so the answers pass the same validation as before. `noul` questions come back as `probability_true`. Requests that name a legacy `jev-*` model (the automation extension sends `jev-latest`) use the configured OpenAI model.

## What it provides

### Service: `@marshal/jev:client`

Bound at `Symbol.for('@marshal/jev:client')`, version `1.0.0` (see `src/api.ts` for the full `JevClient` type). Consumers should import types only from this package and resolve the live instance by symbol injection, never by importing implementation code.

```ts
interface JevClient {
  readonly version: "1.0.0";
  status(): Promise<JevStatus>;                                   // never returns the key
  ask(request: JevAskRequest, options?: JevAskOptions): Promise<JevAskResult>;
  listModels(): Promise<readonly JevModelCard[]>;
}
```

`ask()` validates every answer before resolving (see "Answer validation" below) and throws a typed `JevClientError` with one of these codes on failure:

| Code | Meaning |
| --- | --- |
| `JEV_NOT_CONNECTED` | No key is active (stored or `OPENAI_API_KEY`). |
| `JEV_INVALID_KEY` | OpenAI returned 401/403 for the active key. |
| `JEV_RATE_LIMITED` | OpenAI returned 429 after retries. |
| `JEV_UNAVAILABLE` | OpenAI returned 5xx, or a network failure. |
| `JEV_BAD_REQUEST` | OpenAI rejected the request (any other 4xx), or the caller's input was malformed. |
| `JEV_INVALID_RESPONSE` | OpenAI's response was malformed, a refusal, or didn't pass answer validation. |
| `JEV_ABORTED` | The caller's `AbortSignal` fired, or `timeoutMs` elapsed. |

### Capabilities

| Capability | Purpose | Risk |
| --- | --- | --- |
| `jev.status` | Reports connection state (`not-connected` / `connected` / `invalid-key` / `rate-limited` / `unavailable`), active model, and key `source` (`env`/`stored`). Never the key. | low |
| `jev.models.list` | `GET /v1/models`; returns `{ models: JevModelCard[] }`. | low |
| `jev.ask` | `POST /v1/chat/completions` (Structured Outputs); returns `{ answers, model, usage, latencyMs }`. | medium |
| `jev.connect` | Shows/refreshes the connection card in chat. | low |
| `jev.connection.save_key` | Card-only: verifies a pasted key via `GET /v1/models` **before** sealing and storing it. | medium |
| `jev.connection.test` | Card-only: re-verifies the active key. | low |
| `jev.disconnect` | Card-only: deletes the stored key (an env-supplied key is unaffected). | medium |

## Connection states

```
not-connected → (jev.connect, paste + save) → connected
connected → (key revoked / OpenAI error) → invalid-key | rate-limited | unavailable
any state → (jev.disconnect, stored key only) → not-connected (or env, if OPENAI_API_KEY is set)
```

`jev.status`'s `source` field distinguishes a key that came from the sealed local store (`"stored"`) from one supplied via the `OPENAI_API_KEY` environment variable (`"env"`) — an env-supplied key cannot be edited or removed from the card (its note says so), only a stored key can be disconnected.

## Key storage

The API key is sealed through the host-injected `@marshal/runtime-secrets` module (the same mechanism as `code-review-ext/packages/github-core`) into this extension's `stateDir` (default `.marshal-state/jev-openai`, kept apart from keys saved for TypeSafe). There is **no plaintext key file at any stage**: if secure storage is unavailable, `jev.connection.save_key` fails closed with a clear error rather than falling back to plaintext. `OPENAI_API_KEY` is supported as a **read-only fallback** source when nothing is stored.

## Answer validation and retry — attribution

The `choice`-answer validation (`src/validation.ts::validateChoiceAnswer`) and the HTTP retry policy (`src/transport.ts`: retry 429/503/529 up to twice with `0.5 * 2**attempt` second backoff, never retry a network-level failure) are ported line-for-line in spirit from Browser Use's **jev-ultrafast** reference client (`jev_ultrafast/model.py::validate_choice` / `post_json`), MIT licensed. `noul` validation extends the same finite-probability-mass reasoning to a single value in `[0, 1]`; `score` answers are passed through structurally (bounded numbers) since a score names a level, not a discrete choice, so there is no argmax to check.

## Configuration (`runtime-extension.json` → `configuration.schema`)

- `defaultModel` (string, default `"gpt-5-mini"`)
- `reasoningEffort` (string, optional; defaults to `"minimal"` for gpt-5 / gpt-5-mini / gpt-5-nano)
- `apiBaseUrl` (string, default `"https://api.openai.com"`) — testing/proxy escape hatch
- `stateDir` (string, default `.marshal-state/jev-openai`)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # esbuild → dist/runtime.cjs
```
