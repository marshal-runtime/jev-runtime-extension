import { describe, expect, it } from "vitest";
import { createJevClient } from "./client.js";
import { KeyStore } from "./credentials.js";
import type { InjectedRuntimeSecretsModule } from "./credentials.js";
import { JevClientError } from "./errors.js";
import type { JevFetch } from "./transport.js";

function fakeSecrets(): InjectedRuntimeSecretsModule {
  let counter = 0;
  const plaintextBySealed = new Map<string, string>();
  return {
    isAvailable: () => true,
    seal: ({ plaintext }) => {
      const sealed = `opaque-${counter++}`;
      plaintextBySealed.set(sealed, plaintext);
      return sealed;
    },
    open: ({ sealed }) => {
      const plaintext = plaintextBySealed.get(sealed);
      if (plaintext === undefined) throw new Error("unknown");
      return plaintext;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

/** Routes by pathname so a single mock covers both /v1/chat/completions and /v1/models. */
function routedFetch(handlers: {
  completions?: (init: RequestInit) => Response | Promise<Response>;
  models?: (init: RequestInit) => Response | Promise<Response>;
}): { fetchImpl: JevFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/chat/completions")) return handlers.completions!(init);
    if (url.endsWith("/v1/models")) return handlers.models!(init);
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}

function completion(output: unknown, model = "gpt-5-mini-2025-08-07"): Response {
  return jsonResponse(200, {
    model,
    choices: [{ message: { role: "assistant", content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
}

async function connectedKeyStore(key = "sk-live"): Promise<KeyStore> {
  const store = new KeyStore({ runtimeSecrets: fakeSecrets() });
  await store.setKey(key);
  return store;
}

describe("createJevClient — status()", () => {
  it("reports not-connected when there is no stored key and no env fallback", async () => {
    const keyStore = new KeyStore();
    const { fetchImpl } = routedFetch({});
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.status()).resolves.toEqual({ state: "not-connected", model: "gpt-5-mini" });
  });

  it("reports connected with source 'stored' for a sealed key, and 'env' for the OPENAI_API_KEY fallback", async () => {
    const stored = await connectedKeyStore();
    const { fetchImpl } = routedFetch({});
    const { client: storedClient } = createJevClient({ keyStore: stored, fetchImpl, env: {} });
    await expect(storedClient.status()).resolves.toMatchObject({ state: "connected", source: "stored" });

    const { client: envClient } = createJevClient({ keyStore: new KeyStore(), fetchImpl, env: { OPENAI_API_KEY: "sk-env" } });
    await expect(envClient.status()).resolves.toMatchObject({ state: "connected", source: "env" });
  });

  it("never includes the key anywhere in the status output", async () => {
    const keyStore = await connectedKeyStore("sk-should-never-leak");
    const { fetchImpl } = routedFetch({});
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    const status = await client.status();
    expect(JSON.stringify(status)).not.toContain("sk-should-never-leak");
  });
});

describe("createJevClient — ask()", () => {
  it("sends one structured-output chat completion with the bearer key, and returns a validated choice answer", async () => {
    const keyStore = await connectedKeyStore("sk-ask");
    const { fetchImpl, calls } = routedFetch({
      completions: () => completion({ pick: { ranking: [{ option: "a", probability: 0.9 }, { option: "b", probability: 0.1 }] } }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    const result = await client.ask({
      state: { url: "https://example.com" },
      questions: { pick: { type: "choice", criteria: { a: "Option A", b: "Option B" } } },
    });
    expect(result.answers.pick).toEqual({ type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 });
    expect(result.model).toBe("gpt-5-mini-2025-08-07");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(typeof result.latencyMs).toBe("number");

    const call = calls[0];
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ask");
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("gpt-5-mini");
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.temperature).toBeUndefined();
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(["pick"]);
    expect(JSON.parse(body.messages[1].content)).toEqual({
      state: { url: "https://example.com" },
      questions: { pick: { type: "choice", criteria: { a: "Option A", b: "Option B" } } },
    });
  });

  it("maps legacy jev-* model names to the configured OpenAI model, and passes real OpenAI model names through", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl, calls } = routedFetch({ completions: () => completion({}) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {}, defaultModel: "gpt-4.1-mini" });
    await client.ask({ model: "jev-latest", state: null, questions: {} });
    await client.ask({ state: null, questions: {} });
    await client.ask({ model: "gpt-5-nano", state: null, questions: {} });
    const sent = calls.map((call) => JSON.parse(call.init.body as string));
    expect(sent.map((body) => body.model)).toEqual(["gpt-4.1-mini", "gpt-4.1-mini", "gpt-5-nano"]);
    expect(sent[0].temperature).toBe(0);
    expect(sent[0].reasoning_effort).toBeUndefined();
  });

  it("fills unranked options with 0, renormalizes, and answers noul and score questions", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      completions: () =>
        completion({
          pick: { ranking: [{ option: "c", probability: 0.6 }, { option: "a", probability: 0.2 }] },
          isSpam: { probability_true: 0.12 },
          severity: { ranking: [{ option: "4", probability: 0.7 }, { option: "10", probability: 0.3 }] },
        }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    const result = await client.ask({
      state: null,
      questions: {
        pick: { type: "choice", criteria: { a: "A", b: "B", c: "C" } },
        isSpam: { type: "noul" },
        severity: { type: "score", criteria: { "1": "low", "4": "mid", "10": "high" } },
      },
    });
    const pick = result.answers.pick as { choice: string; probabilities: Record<string, number>; confidence: number };
    expect(pick.choice).toBe("c");
    expect(pick.probabilities.a).toBeCloseTo(0.25);
    expect(pick.probabilities.b).toBe(0);
    expect(pick.probabilities.c).toBeCloseTo(0.75);
    expect(pick.confidence).toBeCloseTo(0.75);
    expect(result.answers.isSpam).toEqual({ type: "noul", noul: 0.12 });
    expect(result.answers.severity).toMatchObject({ type: "score", score: 4, confidence: 0.7 });
  });

  it("rejects an answer that ranks no offered option instead of returning it", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      completions: () => completion({ pick: { ranking: [{ option: "not-an-option", probability: 1 }] } }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(
      client.ask({ state: null, questions: { pick: { type: "choice", criteria: { a: "A" } } } }),
    ).rejects.toMatchObject({ code: "JEV_INVALID_RESPONSE" });
  });

  it("surfaces a model refusal as JEV_INVALID_RESPONSE", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      completions: () => jsonResponse(200, { model: "gpt-5-mini", choices: [{ message: { content: null, refusal: "no" } }] }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: { v: { type: "noul" } } })).rejects.toMatchObject({
      code: "JEV_INVALID_RESPONSE",
    });
  });

  it("throws JEV_NOT_CONNECTED without making a request when there is no key", async () => {
    const { fetchImpl, calls } = routedFetch({});
    const { client } = createJevClient({ keyStore: new KeyStore(), fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code: "JEV_NOT_CONNECTED" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "JEV_INVALID_KEY", "invalid-key"],
    [403, "JEV_INVALID_KEY", "invalid-key"],
    [500, "JEV_UNAVAILABLE", "unavailable"],
    [503, "JEV_UNAVAILABLE", "unavailable"],
  ] as const)("maps HTTP %d to %s and updates status to %s", async (status, code, state) => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({ completions: () => jsonResponse(status, { error: { message: "nope" } }) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code, message: expect.stringContaining("nope") });
    await expect(client.status()).resolves.toMatchObject({ state });
  });

  it("maps a 429 (after retries) to JEV_RATE_LIMITED and updates status", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({ completions: () => jsonResponse(429, { error: { message: "slow down" } }) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code: "JEV_RATE_LIMITED" });
    await expect(client.status()).resolves.toMatchObject({ state: "rate-limited" });
  });

  it("clears a previous error state after a subsequent successful call", async () => {
    const keyStore = await connectedKeyStore();
    let status = 401;
    const { fetchImpl } = routedFetch({
      completions: () => (status === 200 ? completion({}) : jsonResponse(status, {})),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code: "JEV_INVALID_KEY" });
    await expect(client.status()).resolves.toMatchObject({ state: "invalid-key" });
    status = 200;
    await client.ask({ state: null, questions: {} });
    await expect(client.status()).resolves.toMatchObject({ state: "connected" });
  });
});

describe("createJevClient — listModels()", () => {
  it("maps OpenAI's { data: [{ id, created, owned_by }] } response to model cards", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(200, { object: "list", data: [{ id: "gpt-5-mini", created: 1754524800, owned_by: "system" }] }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.listModels()).resolves.toEqual([
      { name: "gpt-5-mini", description: "OpenAI model (system)", release_date: "2025-08-07" },
    ]);
  });

  it("rejects a response without a data array", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({ models: () => jsonResponse(200, [{ id: "x" }]) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.listModels()).rejects.toMatchObject({ code: "JEV_INVALID_RESPONSE" });
  });
});

describe("JevClientHandle.saveKey()", () => {
  it("verifies via GET /v1/models BEFORE storing, and does not store on failure", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } }),
    });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.saveKey("sk-bad")).rejects.toMatchObject({
      code: "JEV_INVALID_KEY",
      message: expect.stringContaining("Incorrect API key"),
    });
    expect(keyStore.hasStoredKey()).toBe(false);
  });

  it("stores the key only after a successful verification, and the key never appears in the returned status", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl, calls } = routedFetch({ models: () => jsonResponse(200, { data: [{ id: "gpt-5-mini" }] }) });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    const status = await handle.saveKey("sk-good-key");
    expect(keyStore.hasStoredKey()).toBe(true);
    expect(status.state).toBe("connected");
    expect(JSON.stringify(status)).not.toContain("sk-good-key");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-good-key");
  });

  it("rejects an empty key without making a network call", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl, calls } = routedFetch({});
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.saveKey("   ")).rejects.toBeInstanceOf(JevClientError);
    expect(calls).toHaveLength(0);
  });
});

describe("JevClientHandle.testConnection() / disconnect()", () => {
  it("testConnection re-verifies the active key and updates status", async () => {
    const keyStore = await connectedKeyStore();
    let status = 200;
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(status, status === 200 ? { data: [{ id: "gpt-5-mini" }] } : { error: { message: "revoked" } }),
    });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.testConnection()).resolves.toMatchObject({ state: "connected" });
    status = 401;
    await expect(handle.testConnection()).resolves.toMatchObject({ state: "invalid-key" });
  });

  it("disconnect clears the stored key so status reverts to not-connected (or env, if set)", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({});
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await handle.disconnect();
    await expect(handle.client.status()).resolves.toEqual({ state: "not-connected", model: "gpt-5-mini" });
  });
});
