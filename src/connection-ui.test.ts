import { describe, expect, it, vi } from "vitest";
import { createJevConnectionUi } from "./connection-ui.js";
import type { JevClientHandle } from "./client.js";
import type { JevStatus } from "./api.js";
import type { RuntimeExtensionActivationContext } from "./extensionProtocol.js";
import type { InvocationContext } from "./runtimeProtocol.js";

function fakeHandle(status: JevStatus, overrides: Partial<JevClientHandle> = {}): JevClientHandle {
  return {
    client: { version: "1.0.0", status: async () => status, ask: vi.fn(), listModels: vi.fn() },
    saveKey: vi.fn(async () => status),
    testConnection: vi.fn(async () => status),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeContext(): { context: RuntimeExtensionActivationContext; shownDocuments: any[] } {
  const shownDocuments: any[] = [];
  const context: RuntimeExtensionActivationContext = {
    configuration: {},
    services: { get: () => { throw new Error("not implemented"); }, tryGet: () => undefined, getAll: () => [] },
    execute: async (request) => {
      if (request.target === "ui.application.list") return { status: "success", result: { output: { instances: [] } } };
      if (request.target === "ui.chat.card.show" || request.target === "ui.application.update") {
        shownDocuments.push((request.input as any).state.document);
        return { status: "success", result: { output: {} } };
      }
      throw new Error(`unexpected target ${request.target}`);
    },
  };
  return { context, shownDocuments };
}

const INVOCATION: InvocationContext = { principal: { id: "agent-1", kind: "agent" }, scope: { sessionId: "session-1" } };

function textOf(document: any): string[] {
  const body = document.root.children[0].children as any[];
  return body.filter((node) => node.type === "text").map((node) => node.text);
}

function buttonIdsOf(document: any): string[] {
  const body = document.root.children[0].children as any[];
  return body.filter((node) => node.type === "button").map((node) => node.id);
}

function badgeToneOf(document: any): string {
  return document.root.children[0].children[1].tone;
}

describe("createJevConnectionUi", () => {
  it("declares mobile + desktop viewports on the published application (required for the phone nav)", () => {
    const { context } = fakeContext();
    const { uiApplications } = createJevConnectionUi(context, fakeHandle({ state: "not-connected", model: "jev-latest" }));
    expect(uiApplications[0]!.metadata).toEqual({ "marshal.ui.viewports": ["mobile", "desktop"] });
  });

  it("uses manifest-valid action ids (host rejects anything outside [a-zA-Z0-9_-])", () => {
    const { context } = fakeContext();
    const { uiApplications } = createJevConnectionUi(context, fakeHandle({ state: "not-connected", model: "jev-latest" }));
    const actions = uiApplications[0]!.application.actions as ReadonlyArray<{ id: string; target: { capability: string } }>;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    const targets = actions.map((action) => action.target.capability);
    expect(targets).toEqual(expect.arrayContaining(["jev.connection.save_key", "ui.application.list", "ui.application.update"]));
  });

  it("reports the real save error when the card refresh is denied", async () => {
    const context: RuntimeExtensionActivationContext = {
      ...fakeContext().context,
      execute: async () => ({ status: "failed", error: { message: "The current application publication does not authorize this capability." } }) as any,
    };
    const handle = fakeHandle(
      { state: "not-connected", model: "jev-latest" },
      { saveKey: vi.fn(async () => { throw new Error("TypeSafe rejected the key (HTTP 401)."); }) },
    );
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    const result = (await capabilityProvider.invoke("jev.connection.save_key", { key: "bad" }, INVOCATION)) as any;
    expect(result.output.message).toContain("TypeSafe rejected the key (HTTP 401).");
    expect(result.output.message).toContain("Card refresh failed");
  });

  it("renders a key-entry form for not-connected", async () => {
    const { context, shownDocuments } = fakeContext();
    const { capabilityProvider } = createJevConnectionUi(context, fakeHandle({ state: "not-connected", model: "jev-latest" }));
    await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
    const document = shownDocuments[0];
    expect(buttonIdsOf(document)).toContain("jev-save-button");
    expect(buttonIdsOf(document)).not.toContain("jev-disconnect-button");
  });

  it("renders Test + Disconnect (no key form) for a connected stored key", async () => {
    const { context, shownDocuments } = fakeContext();
    const status: JevStatus = { state: "connected", model: "jev-latest", source: "stored" };
    const { capabilityProvider } = createJevConnectionUi(context, fakeHandle(status));
    await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
    const document = shownDocuments[0];
    expect(buttonIdsOf(document)).toEqual(["jev-test-button", "jev-disconnect-button"]);
  });

  it("renders an env note (no key form, no disconnect) when the key comes from TYPESAFE_API_KEY", async () => {
    const { context, shownDocuments } = fakeContext();
    const status: JevStatus = { state: "connected", model: "jev-latest", source: "env" };
    const { capabilityProvider } = createJevConnectionUi(context, fakeHandle(status));
    await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
    const document = shownDocuments[0];
    expect(textOf(document).join(" ")).toContain("TYPESAFE_API_KEY");
    expect(buttonIdsOf(document)).toEqual(["jev-test-button"]);
  });

  it("renders the danger tone and a retry key form for invalid-key", async () => {
    const { context, shownDocuments } = fakeContext();
    const status: JevStatus = { state: "invalid-key", model: "jev-latest", source: "stored", detail: "The key was revoked." };
    const { capabilityProvider } = createJevConnectionUi(context, fakeHandle(status));
    await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
    const document = shownDocuments[0];
    expect(badgeToneOf(document)).toBe("danger");
    expect(textOf(document)).toContain("The key was revoked.");
    expect(buttonIdsOf(document)).toContain("jev-save-button");
  });

  it("renders rate-limited and unavailable states with a danger badge", async () => {
    for (const state of ["rate-limited", "unavailable"] as const) {
      const { context, shownDocuments } = fakeContext();
      const { capabilityProvider } = createJevConnectionUi(context, fakeHandle({ state, model: "jev-latest", source: "stored" }));
      await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
      expect(badgeToneOf(shownDocuments[0])).toBe("danger");
    }
  });

  it("save_key calls handle.saveKey with the submitted key and republishes the card", async () => {
    const { context, shownDocuments } = fakeContext();
    const handle = fakeHandle({ state: "connected", model: "jev-latest", source: "stored" });
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    await capabilityProvider.invoke("jev.connection.save_key", { key: "sk-pasted" }, INVOCATION);
    expect(handle.saveKey).toHaveBeenCalledWith("sk-pasted");
    expect(JSON.stringify(shownDocuments[0])).not.toContain("sk-pasted");
  });

  it("save_key rejects an empty key without calling handle.saveKey", async () => {
    const { context } = fakeContext();
    const handle = fakeHandle({ state: "not-connected", model: "jev-latest" });
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    const result = await capabilityProvider.invoke("jev.connection.save_key", { key: "  " }, INVOCATION);
    expect(handle.saveKey).not.toHaveBeenCalled();
    expect((result.output as any).status).toBe("not-connected");
  });

  it("renders the thrown error's message when save_key fails, without crashing the action", async () => {
    const { context, shownDocuments } = fakeContext();
    const handle = fakeHandle(
      { state: "not-connected", model: "jev-latest" },
      {
        saveKey: vi.fn(async () => {
          const { JevClientError } = await import("./errors.js");
          throw new JevClientError("JEV_INVALID_KEY", "TypeSafe rejected that key.");
        }),
      },
    );
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    const result = await capabilityProvider.invoke("jev.connection.save_key", { key: "sk-bad" }, INVOCATION);
    expect((result.output as any).status).toBe("invalid-key");
    expect((result.output as any).message).toBe("TypeSafe rejected that key.");
    expect(textOf(shownDocuments[0])).toContain("TypeSafe rejected that key.");
  });

  it("test and disconnect actions call through to the handle", async () => {
    const { context } = fakeContext();
    const handle = fakeHandle({ state: "connected", model: "jev-latest", source: "stored" });
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    await capabilityProvider.invoke("jev.connection.test", {}, INVOCATION);
    expect(handle.testConnection).toHaveBeenCalled();
    await capabilityProvider.invoke("jev.disconnect", {}, INVOCATION);
    expect(handle.disconnect).toHaveBeenCalled();
  });

  it("updates (rather than re-shows) an already-visible card, keeping Disconnect actionable while connected", async () => {
    const shownDocuments: any[] = [];
    const updateCalls: unknown[] = [];
    const context: RuntimeExtensionActivationContext = {
      configuration: {},
      services: { get: () => { throw new Error("not implemented"); }, tryGet: () => undefined, getAll: () => [] },
      execute: async (request) => {
        if (request.target === "ui.application.list") {
          return { status: "success", result: { output: { instances: [{ surface: "inline-card", instanceId: "i1" }] } } };
        }
        if (request.target === "ui.application.update") {
          updateCalls.push(request.input);
          shownDocuments.push((request.input as any).state.document);
          return { status: "success", result: { output: {} } };
        }
        throw new Error(`unexpected target ${request.target}`);
      },
    };
    const handle = fakeHandle({ state: "connected", model: "jev-latest", source: "stored" });
    const { capabilityProvider } = createJevConnectionUi(context, handle);
    await capabilityProvider.invoke("jev.connect", {}, INVOCATION);
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as any).instanceId).toBe("i1");
    expect(buttonIdsOf(shownDocuments[0])).toContain("jev-disconnect-button");
  });
});
