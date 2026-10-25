import { describe, expect, it, vi } from "vitest";
import { KeyStore, SecretsUnavailableError } from "./credentials.js";
import type { InjectedRuntimeSecretsModule } from "./credentials.js";

function fakeSecrets(overrides: Partial<InjectedRuntimeSecretsModule> = {}): InjectedRuntimeSecretsModule {
  // Opaque, non-reversible-looking tokens (no plaintext substring) so tests
  // can assert the sealed blob never leaks the key, same shape as a real
  // OS-backed seal would produce.
  let counter = 0;
  const plaintextBySealed = new Map<string, string>();
  return {
    isAvailable: () => true,
    seal: ({ plaintext }) => {
      const sealed = `opaque-blob-${counter++}`;
      plaintextBySealed.set(sealed, plaintext);
      return sealed;
    },
    open: ({ sealed }) => {
      const plaintext = plaintextBySealed.get(sealed);
      if (plaintext === undefined) throw new Error("unknown sealed blob");
      return plaintext;
    },
    ...overrides,
  };
}

describe("KeyStore", () => {
  it("fails closed with SecretsUnavailableError when no runtime-secrets module is injected", async () => {
    const store = new KeyStore();
    await expect(store.setKey("sk-real")).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(store.hasStoredKey()).toBe(false);
  });

  it("fails closed when isAvailable() reports false, never storing plaintext", async () => {
    const store = new KeyStore({ runtimeSecrets: fakeSecrets({ isAvailable: () => false }) });
    await expect(store.setKey("sk-real")).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(store.hasStoredKey()).toBe(false);
  });

  it("fails closed when seal() throws", async () => {
    const store = new KeyStore({
      runtimeSecrets: fakeSecrets({
        seal: () => {
          throw new Error("keychain locked");
        },
      }),
    });
    await expect(store.setKey("sk-real")).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(store.hasStoredKey()).toBe(false);
  });

  it("seals on setKey and only ever exposes the opaque sealed blob, never the plaintext", async () => {
    const onSealedStateChanged = vi.fn();
    const store = new KeyStore({ runtimeSecrets: fakeSecrets(), onSealedStateChanged });
    await store.setKey("sk-real-key");
    const exported = store.exportSealedState();
    expect(exported).toBeDefined();
    expect(exported!.sealed).not.toContain("sk-real-key");
    expect(JSON.stringify(exported)).not.toContain("sk-real-key");
    expect(onSealedStateChanged).toHaveBeenCalledWith(exported);
  });

  it("round-trips the plaintext key through getKey() when secrets are available", async () => {
    const store = new KeyStore({ runtimeSecrets: fakeSecrets() });
    await store.setKey("sk-round-trip");
    await expect(store.getKey()).resolves.toBe("sk-round-trip");
  });

  it("returns undefined from getKey() when the sealed blob can no longer be opened", async () => {
    const secrets = fakeSecrets();
    const store = new KeyStore({ runtimeSecrets: secrets });
    await store.setKey("sk-locked-later");
    store.setRuntimeSecrets(fakeSecrets({ isAvailable: () => false }));
    await expect(store.getKey()).resolves.toBeUndefined();
  });

  it("clear() removes the stored key and notifies once", async () => {
    const onSealedStateChanged = vi.fn();
    const store = new KeyStore({ runtimeSecrets: fakeSecrets(), onSealedStateChanged });
    await store.setKey("sk-clear-me");
    onSealedStateChanged.mockClear();
    store.clear();
    expect(store.hasStoredKey()).toBe(false);
    expect(onSealedStateChanged).toHaveBeenCalledWith(undefined);
    store.clear();
    expect(onSealedStateChanged).toHaveBeenCalledTimes(1);
  });

  it("restoreSealedState imports without firing onSealedStateChanged, and is readable afterward", async () => {
    const secrets = fakeSecrets();
    const producer = new KeyStore({ runtimeSecrets: secrets });
    await producer.setKey("sk-restored");
    const exported = producer.exportSealedState();

    const onSealedStateChanged = vi.fn();
    const restored = new KeyStore({ runtimeSecrets: secrets, onSealedStateChanged });
    restored.restoreSealedState(exported);
    expect(onSealedStateChanged).not.toHaveBeenCalled();
    await expect(restored.getKey()).resolves.toBe("sk-restored");
  });
});
