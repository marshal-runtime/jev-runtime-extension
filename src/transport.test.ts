import { describe, expect, it, vi } from "vitest";
import { getJsonWithRetry, postJsonWithRetry } from "./transport.js";
import type { JevFetch } from "./transport.js";

function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("postJsonWithRetry", () => {
  it("sends the exact method/headers/body shape with the bearer auth header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: JevFetch = async (url, init) => {
      calls.push({ url, init });
      return fakeResponse(200, { ok: true });
    };
    await postJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/systemone", "sk-secret", {
      model: "jev-latest",
      state: null,
      questions: {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-secret", "Content-Type": "application/json" });
    expect(calls[0].init.body).toBe(JSON.stringify({ model: "jev-latest", state: null, questions: {} }));
  });

  it("never puts the API key in the URL or the request body — only the Authorization header", async () => {
    const fetchImpl: JevFetch = async () => fakeResponse(200, {});
    const calls: { url: string; init: RequestInit }[] = [];
    const wrapped: JevFetch = async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    };
    await postJsonWithRetry(wrapped, "https://api.typesafe.ai/v1/systemone", "sk-top-secret", { state: 1, questions: {} });
    expect(calls[0].url).not.toContain("sk-top-secret");
    expect(calls[0].init.body).not.toContain("sk-top-secret");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-top-secret");
  });

  it("retries 429/503/529 up to twice with backoff, then returns the final status", async () => {
    const statuses = [503, 429, 200];
    let call = 0;
    const fetchImpl: JevFetch = async () => fakeResponse(statuses[call++]!, { attempt: call });
    const sleeps: number[] = [];
    const result = await postJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/systemone", "k", {}, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(call).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(result.status).toBe(200);
  });

  it("gives up after exhausting all three attempts on a persistently retryable status", async () => {
    let call = 0;
    const fetchImpl: JevFetch = async () => {
      call++;
      return fakeResponse(529, { error: "overloaded" });
    };
    const result = await postJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/systemone", "k", {}, {
      sleep: async () => {},
    });
    expect(call).toBe(3);
    expect(result.status).toBe(529);
  });

  it("does not retry a non-retryable error status", async () => {
    let call = 0;
    const fetchImpl: JevFetch = async () => {
      call++;
      return fakeResponse(400, { error: "bad request" });
    };
    const result = await postJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/systemone", "k", {}, {
      sleep: vi.fn(async () => {}),
    });
    expect(call).toBe(1);
    expect(result.status).toBe(400);
  });

  it("propagates a network-level failure without retrying", async () => {
    let call = 0;
    const fetchImpl: JevFetch = async () => {
      call++;
      throw new Error("ECONNREFUSED");
    };
    await expect(
      postJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/systemone", "k", {}, { sleep: async () => {} }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(call).toBe(1);
  });
});

describe("getJsonWithRetry", () => {
  it("sends a GET with the bearer auth header and no body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: JevFetch = async (url, init) => {
      calls.push({ url, init });
      return fakeResponse(200, [{ name: "jev-latest" }]);
    };
    const result = await getJsonWithRetry(fetchImpl, "https://api.typesafe.ai/v1/models", "sk-secret");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
    expect(result.body).toEqual([{ name: "jev-latest" }]);
  });
});
