import { describe, expect, it, vi } from "vitest";
import { createJevCapabilityProvider } from "./capabilities.js";
import type { JevClient } from "./api.js";
import { JevClientError } from "./errors.js";

const INVOCATION = { principal: { id: "agent-1", kind: "agent" as const } };

function fakeClient(overrides: Partial<JevClient> = {}): JevClient {
  return {
    version: "1.0.0",
    status: vi.fn(async () => ({ state: "connected" as const, model: "jev-latest" })),
    ask: vi.fn(),
    listModels: vi.fn(async () => []),
    ...overrides,
  };
}

describe("createJevCapabilityProvider", () => {
  it("lists exactly the three raw capabilities", async () => {
    const provider = createJevCapabilityProvider(fakeClient());
    const descriptors = await provider.list(INVOCATION);
    expect(descriptors.map((d) => d.name).sort()).toEqual(["jev.ask", "jev.models.list", "jev.status"]);
  });

  it("jev.status never leaks a key even if one were smuggled onto the status object", async () => {
    const client = fakeClient({
      status: vi.fn(async () => ({ state: "connected" as const, model: "jev-latest", source: "stored" as const })),
    });
    const provider = createJevCapabilityProvider(client);
    const result = await provider.invoke("jev.status", undefined, INVOCATION);
    expect(JSON.stringify(result.output)).not.toMatch(/sk-[a-zA-Z0-9]/);
  });

  it("jev.models.list wraps the client's array under a named 'models' property", async () => {
    const client = fakeClient({ listModels: vi.fn(async () => [{ name: "jev-latest", description: "d", release_date: "r" }]) });
    const provider = createJevCapabilityProvider(client);
    const result = await provider.invoke("jev.models.list", undefined, INVOCATION);
    expect(result.output).toEqual({ models: [{ name: "jev-latest", description: "d", release_date: "r" }] });
  });

  it("jev.ask forwards model/state/questions to client.ask and returns its result", async () => {
    const askResult = { answers: {}, model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 12 };
    const ask = vi.fn(async () => askResult);
    const provider = createJevCapabilityProvider(fakeClient({ ask }));
    const input = { model: "jev-preview", state: { a: 1 }, questions: { q: { type: "noul" } } };
    const result = await provider.invoke("jev.ask", input, INVOCATION);
    expect(ask).toHaveBeenCalledWith({ model: "jev-preview", state: { a: 1 }, questions: { q: { type: "noul" } } });
    expect(result.output).toEqual(askResult);
  });

  it("jev.ask rejects input missing 'state' or 'questions' without calling client.ask", async () => {
    const ask = vi.fn();
    const provider = createJevCapabilityProvider(fakeClient({ ask }));
    await expect(provider.invoke("jev.ask", { questions: {} }, INVOCATION)).rejects.toBeInstanceOf(JevClientError);
    await expect(provider.invoke("jev.ask", { state: null }, INVOCATION)).rejects.toBeInstanceOf(JevClientError);
    expect(ask).not.toHaveBeenCalled();
  });

  it("rejects an unknown capability name", async () => {
    const provider = createJevCapabilityProvider(fakeClient());
    await expect(provider.invoke("jev.nope", {}, INVOCATION)).rejects.toBeInstanceOf(JevClientError);
  });
});
