import { describe, expect, it } from "vitest";
import extensionModule, { resolveInjectedRuntimeSecretsModule } from "./extension.js";
import { JEV_CLIENT_SERVICE_TOKEN } from "./api.js";
import type { RuntimeExtensionActivationContext } from "./extensionProtocol.js";

function fakeContext(configuration: Record<string, unknown> = {}): RuntimeExtensionActivationContext {
  return {
    configuration,
    services: { get: () => { throw new Error("not implemented"); }, tryGet: () => undefined, getAll: () => [] },
    execute: async () => ({ status: "success", result: { output: { instances: [] } } }),
  };
}

describe("extension activation", () => {
  it("contributes the @marshal/jev:client service, both capability providers, and the connect uiApplication", async () => {
    const activation = await extensionModule.activate(fakeContext());
    expect(activation.serviceContributions).toHaveLength(1);
    expect(activation.serviceContributions![0]!.token).toBe(JEV_CLIENT_SERVICE_TOKEN);
    const client = activation.serviceContributions![0]!.binding.useValue as { status: () => Promise<unknown> };
    await expect(client.status()).resolves.toMatchObject({ state: "not-connected" });

    const lists = await Promise.all(activation.capabilityProviders!.map((provider) => provider.list(undefined as never)));
    const capabilityNames = new Set(lists.flat().map((d) => d.name));
    for (const name of ["jev.status", "jev.models.list", "jev.ask", "jev.connect", "jev.connection.save_key", "jev.connection.test", "jev.disconnect"]) {
      expect(capabilityNames.has(name)).toBe(true);
    }

    expect(activation.uiApplications).toHaveLength(1);
    expect(activation.uiApplications![0]!.metadata).toEqual({ "marshal.ui.viewports": ["mobile", "desktop"] });
  });

  it("respects a configured defaultModel", async () => {
    const activation = await extensionModule.activate(fakeContext({ defaultModel: "jev-preview" }));
    const client = activation.serviceContributions![0]!.binding.useValue as { status: () => Promise<{ model: string }> };
    await expect(client.status()).resolves.toMatchObject({ model: "jev-preview" });
  });
});

describe("resolveInjectedRuntimeSecretsModule", () => {
  it("fails closed to undefined when the loader throws (host has not wired the module)", () => {
    expect(
      resolveInjectedRuntimeSecretsModule(() => {
        throw new Error("Cannot find module '@marshal/runtime-secrets'");
      }),
    ).toBeUndefined();
  });

  it("fails closed to undefined on a malformed module shape", () => {
    expect(resolveInjectedRuntimeSecretsModule(() => ({ isAvailable: () => true }))).toBeUndefined();
  });

  it("accepts a well-formed module", () => {
    const mod = { isAvailable: () => true, seal: () => "x", open: () => "y" };
    expect(resolveInjectedRuntimeSecretsModule(() => mod)).toBe(mod);
  });
});
