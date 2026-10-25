# @marshal/jev

Marshal Runtime extension connecting to [TypeSafe](https://typesafe.ai)'s **Jev "System One"** model: fast, validated `choice` / `score` / `noul` answers over an arbitrary JSON `state`, plus model discovery — behind a sealed, per-machine API key.

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
| `JEV_NOT_CONNECTED` | No key is active (stored or `TYPESAFE_API_KEY`). |
| `JEV_INVALID_KEY` | TypeSafe returned 401/403 for the active key. |
| `JEV_RATE_LIMITED` | TypeSafe returned 429 after retries. |
| `JEV_UNAVAILABLE` | TypeSafe returned 5xx/529, or a network failure. |
| `JEV_BAD_REQUEST` | TypeSafe rejected the request (any other 4xx), or the caller's input was malformed. |
| `JEV_INVALID_RESPONSE` | TypeSafe's response didn't pass answer validation. |
| `JEV_ABORTED` | The caller's `AbortSignal` fired, or `timeoutMs` elapsed. |

### Capabilities

| Capability | Purpose | Risk |
| --- | --- | --- |
| `jev.status` | Reports connection state (`not-connected` / `connected` / `invalid-key` / `rate-limited` / `unavailable`), active model, and key `source` (`env`/`stored`). Never the key. | low |
| `jev.models.list` | `GET /v1/models`; returns `{ models: JevModelCard[] }`. | low |
| `jev.ask` | `POST /v1/systemone`; returns `{ answers, model, usage, latencyMs }`. | medium |
| `jev.connect` | Shows/refreshes the connection card in chat. | low |
| `jev.connection.save_key` | Card-only: verifies a pasted key via `GET /v1/models` **before** sealing and storing it. | medium |
| `jev.connection.test` | Card-only: re-verifies the active key. | low |
| `jev.disconnect` | Card-only: deletes the stored key (an env-supplied key is unaffected). | medium |

## Connection states

```
not-connected → (jev.connect, paste + save) → connected
connected → (key revoked / TypeSafe error) → invalid-key | rate-limited | unavailable
any state → (jev.disconnect, stored key only) → not-connected (or env, if TYPESAFE_API_KEY is set)
```

`jev.status`'s `source` field distinguishes a key that came from the sealed local store (`"stored"`) from one supplied via the `TYPESAFE_API_KEY` environment variable (`"env"`) — an env-supplied key cannot be edited or removed from the card (its note says so), only a stored key can be disconnected.

## Key storage

The API key is sealed through the host-injected `@marshal/runtime-secrets` module (the same mechanism as `code-review-ext/packages/github-core`) into this extension's `stateDir` (default `.marshal-state/jev`). There is **no plaintext key file at any stage**: if secure storage is unavailable, `jev.connection.save_key` fails closed with a clear error rather than falling back to plaintext. `TYPESAFE_API_KEY` is supported as a **read-only fallback** source when nothing is stored.

## Answer validation and retry — attribution

The `choice`-answer validation (`src/validation.ts::validateChoiceAnswer`) and the HTTP retry policy (`src/transport.ts`: retry 429/503/529 up to twice with `0.5 * 2**attempt` second backoff, never retry a network-level failure) are ported line-for-line in spirit from Browser Use's **jev-ultrafast** reference client (`jev_ultrafast/model.py::validate_choice` / `post_json`), MIT licensed. `noul` validation extends the same finite-probability-mass reasoning to a single value in `[0, 1]`; `score` answers are passed through structurally (bounded numbers) since a score names a level, not a discrete choice, so there is no argmax to check.

## Configuration (`runtime-extension.json` → `configuration.schema`)

- `defaultModel` (string, default `"jev-latest"`)
- `apiBaseUrl` (string, default `"https://api.typesafe.ai"`) — testing/self-host escape hatch
- `stateDir` (string, default `.marshal-state/jev`)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # esbuild → dist/runtime.cjs
```
