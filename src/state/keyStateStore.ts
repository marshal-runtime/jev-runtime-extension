/**
 * Production persistence for @marshal/jev's sealed API-key state. Mirrors
 * the injectable-fs-primitives + atomic-write (temp file + rename) pattern
 * in code-review-ext/packages/github-core/src/state/credentialStateStore.ts,
 * simplified for a single sealed record rather than a per-account registry.
 *
 * Nothing in this file's payload is secret: `sealedKey` is already opaque
 * ciphertext (or absent, fail-closed).
 */
import type { SealedKeyRecord } from "../credentials.js";

export interface KeyStateRecord {
  readonly sealedKey: SealedKeyRecord | undefined;
}

export const EMPTY_KEY_STATE: KeyStateRecord = Object.freeze({ sealedKey: undefined });

export interface KeyStateStore {
  load(): Promise<KeyStateRecord>;
  save(record: KeyStateRecord): Promise<void>;
}

/** Injectable low-level primitives so tests can simulate absence/corruption without real fs. */
export interface StateFsPrimitives {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isValidSealedKey(value: unknown): value is SealedKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SealedKeyRecord>;
  return typeof record.namespace === "string" && typeof record.sealed === "string";
}

function isValidRecord(value: unknown): value is KeyStateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<KeyStateRecord>;
  return record.sealedKey === undefined || isValidSealedKey(record.sealedKey);
}

/**
 * Real fs-backed `KeyStateStore`, rooted at one JSON file under the
 * configured `stateDir`. Atomic writes ALWAYS go through a temp-file +
 * rename. A missing, corrupt, or malformed file fails closed to
 * `EMPTY_KEY_STATE` rather than throwing — activation must never crash on a
 * damaged state file (CLAUDE.md security rule: bad on-disk JSON must not
 * crash the main process).
 */
export class NodeFsKeyStateStore implements KeyStateStore {
  private readonly filePath: string;
  private readonly randomSuffix: () => string;

  constructor(
    private readonly stateDir: string,
    private readonly fs: StateFsPrimitives,
    options: { readonly fileName?: string; readonly randomSuffix?: () => string } = {},
  ) {
    this.filePath = `${stateDir.replace(/\/+$/, "")}/${options.fileName ?? "key.json"}`;
    this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2));
  }

  async load(): Promise<KeyStateRecord> {
    let text: string;
    try {
      text = await this.fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) return EMPTY_KEY_STATE;
      return EMPTY_KEY_STATE; // fail closed on any other read failure too — never crash activation
    }
    try {
      // SF-4: the parsed shape is validated by isValidRecord() below before any field is trusted.
      const parsed: unknown = JSON.parse(text);
      return isValidRecord(parsed) ? parsed : EMPTY_KEY_STATE;
    } catch {
      return EMPTY_KEY_STATE;
    }
  }

  async save(record: KeyStateRecord): Promise<void> {
    await this.fs.mkdir(this.stateDir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${this.randomSuffix()}`;
    await this.fs.writeFile(tmpPath, JSON.stringify(record), "utf8");
    await this.fs.rename(tmpPath, this.filePath);
  }
}

/** In-memory `KeyStateStore` for fast unit tests that don't need real fs semantics. */
export class MemoryKeyStateStore implements KeyStateStore {
  private record: KeyStateRecord = EMPTY_KEY_STATE;

  async load(): Promise<KeyStateRecord> {
    return this.record;
  }

  async save(record: KeyStateRecord): Promise<void> {
    this.record = record;
  }
}
