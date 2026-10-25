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

/** Routes by pathname so a single mock covers both /v1/systemone and /v1/models. */
function routedFetch(handlers: {
  systemone?: (init: RequestInit) => Response | Promise<Response>;
  models?: (init: RequestInit) => Response | Promise<Response>;
}): { fetchImpl: JevFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/systemone")) return handlers.systemone!(init);
    if (url.endsWith("/v1/models")) return handlers.models!(init);
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
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
    await expect(client.status()).resolves.toEqual({ state: "not-connected", model: "jev-latest" });
  });

  it("reports connected with source 'stored' for a sealed key, and 'env' for the TYPESAFE_API_KEY fallback", async () => {
    const stored = await connectedKeyStore();
    const { fetchImpl } = routedFetch({});
    const { client: storedClient } = createJevClient({ keyStore: stored, fetchImpl, env: {} });
    await expect(storedClient.status()).resolves.toMatchObject({ state: "connected", source: "stored" });

    const { client: envClient } = createJevClient({ keyStore: new KeyStore(), fetchImpl, env: { TYPESAFE_API_KEY: "sk-env" } });
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
  it("sends model/state/questions and the bearer key, and returns a validated choice answer", async () => {
    const keyStore = await connectedKeyStore("sk-ask");
    const { fetchImpl, calls } = routedFetch({
      systemone: () =>
        jsonResponse(200, {
          answers: { pick: { choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } },
          model: "jev-1.13.0",
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    const result = await client.ask({
      model: "jev-1.13.0",
      state: { url: "https://example.com" },
      questions: { pick: { type: "choice", criteria: { a: "Option A", b: "Option B" } } },
    });
    expect(result.answers.pick).toEqual({ type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(typeof result.latencyMs).toBe("number");

    const call = calls[0];
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ask");
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: "jev-1.13.0",
      state: { url: "https://example.com" },
      questions: { pick: { type: "choice", criteria: { a: "Option A", b: "Option B" } } },
    });
  });

  it("defaults to the configured default model when the request omits one", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl, calls } = routedFetch({
      systemone: () => jsonResponse(200, { answers: {}, model: "jev-latest", usage: {} }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {}, defaultModel: "jev-preview" });
    await client.ask({ state: null, questions: {} });
    expect(JSON.parse(calls[0].init.body as string).model).toBe("jev-preview");
  });

  it("passes through noul and score answers", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      systemone: () =>
        jsonResponse(200, {
          answers: {
            isSpam: { noul: 0.12 },
            severity: { score: 4, probabilities: { "1": 0.1, "4": 0.7, "10": 0.2 }, confidence: 0.7 },
          },
          model: "jev-latest",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    const result = await client.ask({
      state: null,
      questions: { isSpam: { type: "noul" }, severity: { type: "score", criteria: { "1": "low", "10": "high" } } },
    });
    expect(result.answers.isSpam).toEqual({ type: "noul", noul: 0.12 });
    expect(result.answers.severity).toMatchObject({ type: "score", score: 4 });
  });

  it("rejects an invalid choice answer instead of returning it", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      systemone: () =>
        jsonResponse(200, {
          answers: { pick: { choice: "not-an-option", probabilities: { a: 1 }, confidence: 1 } },
          model: "jev-latest",
          usage: {},
        }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(
      client.ask({ state: null, questions: { pick: { type: "choice", criteria: { a: "A" } } } }),
    ).rejects.toMatchObject({ code: "JEV_INVALID_RESPONSE" });
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
    [529, "JEV_UNAVAILABLE", "unavailable"],
  ] as const)("maps HTTP %d to %s and updates status to %s", async (status, code, state) => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({ systemone: () => jsonResponse(status, { error: "nope" }) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code });
    await expect(client.status()).resolves.toMatchObject({ state });
  });

  it("maps a 429 (after retries) to JEV_RATE_LIMITED and updates status", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({ systemone: () => jsonResponse(429, { error: "slow down" }) });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.ask({ state: null, questions: {} })).rejects.toMatchObject({ code: "JEV_RATE_LIMITED" });
    await expect(client.status()).resolves.toMatchObject({ state: "rate-limited" });
  });

  it("clears a previous error state after a subsequent successful call", async () => {
    const keyStore = await connectedKeyStore();
    let status = 401;
    const { fetchImpl } = routedFetch({
      systemone: () => jsonResponse(status, status === 200 ? { answers: {}, model: "jev-latest", usage: {} } : {}),
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
  it("accepts a bare array response", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(200, [{ name: "jev-latest", description: "d", release_date: "2026-01-01" }]),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.listModels()).resolves.toEqual([{ name: "jev-latest", description: "d", release_date: "2026-01-01" }]);
  });

  it("accepts a { data: [...] } response", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(200, { data: [{ name: "jev-preview", description: "d", release_date: "2026-02-01" }] }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.listModels()).resolves.toEqual([{ name: "jev-preview", description: "d", release_date: "2026-02-01" }]);
  });

  it("accepts TypeSafe's real { models: [...] } response (per @typesafe-ai/sdk 0.6.0 unwrapModels)", async () => {
    const keyStore = await connectedKeyStore();
    const { fetchImpl } = routedFetch({
      models: () => jsonResponse(200, { models: [{ name: "jev-1.13.0", description: "d", release_date: "2026-09-15" }] }),
    });
    const { client } = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(client.listModels()).resolves.toEqual([{ name: "jev-1.13.0", description: "d", release_date: "2026-09-15" }]);
  });
});

describe("JevClientHandle.saveKey()", () => {
  it("verifies via GET /v1/models BEFORE storing, and does not store on failure", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl } = routedFetch({ models: () => jsonResponse(401, { error: "bad key" }) });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.saveKey("sk-bad")).rejects.toMatchObject({ code: "JEV_INVALID_KEY" });
    expect(keyStore.hasStoredKey()).toBe(false);
  });

  it("treats TypeSafe's 403 authentication_error as an invalid key and surfaces its message", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl } = routedFetch({
      models: () =>
        jsonResponse(403, { detail: { error_type: "authentication_error", message: "Cannot authenticate with the server." } }),
    });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.saveKey("sk-bad")).rejects.toMatchObject({
      code: "JEV_INVALID_KEY",
      message: expect.stringContaining("Cannot authenticate"),
    });
    expect(keyStore.hasStoredKey()).toBe(false);
  });

  it("saves a key verified by the real { models: [...] } response shape", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl } = routedFetch({ models: () => jsonResponse(200, { models: [{ name: "jev-latest" }] }) });
    const handle = createJevClient({ keyStore, fetchImpl, env: {} });
    await expect(handle.saveKey("sk-good")).resolves.toMatchObject({ state: "connected" });
    expect(keyStore.hasStoredKey()).toBe(true);
  });

  it("stores the key only after a successful verification, and the key never appears in the returned status", async () => {
    const keyStore = new KeyStore({ runtimeSecrets: fakeSecrets() });
    const { fetchImpl, calls } = routedFetch({
      models: () => jsonResponse(200, [{ name: "jev-latest", description: "", release_date: "" }]),
    });
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
      models: () => jsonResponse(status, status === 200 ? [{ name: "jev-latest", description: "", release_date: "" }] : { error: "revoked" }),
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
    await expect(handle.client.status()).resolves.toEqual({ state: "not-connected", model: "jev-latest" });
  });
});
