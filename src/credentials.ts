/**
 * Memory-only API-key store with a transparent upgrade hook probing the
 * REAL injected `@marshal/runtime-secrets` module — mirrors
 * code-review-ext/packages/github-core/src/credentials.ts, simplified for a
 * single stored key rather than a per-account registry.
 *
 * Invariants:
 *  - There is NO plaintext key file at any stage. This store never writes to
 *    disk itself; only opaque sealed blobs are ever exposed for external
 *    persistence via `exportSealedState()`/`onSealedStateChanged`.
 *  - Before `@marshal/runtime-secrets` is available, the key lives in memory
 *    for the process lifetime only.
 *  - Failure to seal/open FAILS CLOSED: stays on (or falls back to) the
 *    memory-only path rather than ever persisting plaintext. If saving is
 *    requested and sealing is unavailable, the save itself fails (see
 *    `client.ts`'s `saveKey`) rather than silently storing plaintext.
 *  - No method here ever logs, returns, or serializes the raw key.
 */

/**
 * Real host-injected secrets module contract — exact mirror of
 * `RuntimeExtensionSecrets` (electron/marshal-runtime/extension-secrets.ts in
 * the live host source) as exposed under the injected module specifier
 * `'@marshal/runtime-secrets'` — NOT a service/symbol lookup.
 */
export interface InjectedRuntimeSecretsModule {
  isAvailable(): boolean;
  seal(request: { readonly namespace: string; readonly plaintext: string }): string;
  open(request: { readonly namespace: string; readonly sealed: string }): string;
}

export interface SealedKeyRecord {
  readonly namespace: string;
  readonly sealed: string;
}

export interface KeyStoreOptions {
  readonly runtimeSecrets?: InjectedRuntimeSecretsModule;
  readonly namespace?: string;
  readonly onSealedStateChanged?: (record: SealedKeyRecord | undefined) => void;
}

const DEFAULT_NAMESPACE = "@marshal/jev";

/** Thrown by `setKey` when sealing is requested but unavailable — callers must not fall back to plaintext. */
export class SecretsUnavailableError extends Error {
  constructor() {
    super("Cannot save the TypeSafe API key: the host's secure secret storage is unavailable on this machine.");
    this.name = "SecretsUnavailableError";
  }
}

export class KeyStore {
  private memoryKey: string | undefined;
  private sealedRecord: SealedKeyRecord | undefined;
  private readonly namespace: string;
  private runtimeSecrets: InjectedRuntimeSecretsModule | undefined;
  private readonly onSealedStateChanged: ((record: SealedKeyRecord | undefined) => void) | undefined;

  constructor(options: KeyStoreOptions = {}) {
    this.runtimeSecrets = options.runtimeSecrets;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.onSealedStateChanged = options.onSealedStateChanged;
  }

  setRuntimeSecrets(runtimeSecrets: InjectedRuntimeSecretsModule | undefined): void {
    this.runtimeSecrets = runtimeSecrets;
  }

  private secretsAvailable(): boolean {
    if (!this.runtimeSecrets) return false;
    try {
      return this.runtimeSecrets.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Seals and persists the key. Throws `SecretsUnavailableError` when
   * sealing is not available — this store never falls back to a plaintext
   * persistence path (CLAUDE.md security rule: no plaintext credential
   * files). The in-memory copy is set only once sealing succeeds.
   */
  async setKey(key: string): Promise<void> {
    if (!this.secretsAvailable()) throw new SecretsUnavailableError();
    let sealed: string;
    try {
      sealed = this.runtimeSecrets!.seal({ namespace: this.namespace, plaintext: key });
    } catch {
      throw new SecretsUnavailableError();
    }
    if (typeof sealed !== "string" || sealed.length === 0) throw new SecretsUnavailableError();
    this.sealedRecord = { namespace: this.namespace, sealed };
    this.memoryKey = undefined;
    this.notifySealedStateChanged();
  }

  async getKey(): Promise<string | undefined> {
    if (this.sealedRecord && this.secretsAvailable()) {
      try {
        const plaintext = this.runtimeSecrets!.open({
          namespace: this.sealedRecord.namespace,
          sealed: this.sealedRecord.sealed,
        });
        if (typeof plaintext === "string" && plaintext.length > 0) return plaintext;
      } catch {
        // fail closed: no stored key is usable right now.
        return undefined;
      }
    }
    return this.memoryKey;
  }

  hasStoredKey(): boolean {
    return this.sealedRecord !== undefined || this.memoryKey !== undefined;
  }

  clear(): void {
    const had = this.hasStoredKey();
    this.memoryKey = undefined;
    this.sealedRecord = undefined;
    if (had) this.notifySealedStateChanged();
  }

  exportSealedState(): SealedKeyRecord | undefined {
    return this.sealedRecord;
  }

  /** Imports a previously-exported sealed record (restore on activation). Never fires `onSealedStateChanged`. */
  restoreSealedState(record: SealedKeyRecord | undefined): void {
    if (!record) return;
    this.sealedRecord = record;
    this.memoryKey = undefined;
  }

  private notifySealedStateChanged(): void {
    try {
      this.onSealedStateChanged?.(this.sealedRecord);
    } catch {
      // A caller-supplied persistence hook must never crash credential mutation.
    }
  }
}
