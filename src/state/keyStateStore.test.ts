import { describe, expect, it } from "vitest";
import { EMPTY_KEY_STATE, MemoryKeyStateStore, NodeFsKeyStateStore } from "./keyStateStore.js";
import type { StateFsPrimitives } from "./keyStateStore.js";

function memoryFs(initial: Record<string, string> = {}): StateFsPrimitives & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFile: async (path) => {
      if (!(path in files)) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files[path]!;
    },
    writeFile: async (path, data) => {
      files[path] = data;
    },
    rename: async (oldPath, newPath) => {
      files[newPath] = files[oldPath]!;
      delete files[oldPath];
    },
    mkdir: async () => {},
  };
}

describe("NodeFsKeyStateStore", () => {
  it("fails closed to EMPTY_KEY_STATE when the file is missing", async () => {
    const store = new NodeFsKeyStateStore("/state/jev", memoryFs());
    await expect(store.load()).resolves.toEqual(EMPTY_KEY_STATE);
  });

  it("fails closed to EMPTY_KEY_STATE on corrupt JSON, never throwing", async () => {
    const fs = memoryFs({ "/state/jev/key.json": "{not json" });
    const store = new NodeFsKeyStateStore("/state/jev", fs);
    await expect(store.load()).resolves.toEqual(EMPTY_KEY_STATE);
  });

  it("fails closed to EMPTY_KEY_STATE on a malformed (but valid JSON) shape", async () => {
    const fs = memoryFs({ "/state/jev/key.json": JSON.stringify({ sealedKey: { namespace: 123 } }) });
    const store = new NodeFsKeyStateStore("/state/jev", fs);
    await expect(store.load()).resolves.toEqual(EMPTY_KEY_STATE);
  });

  it("round-trips a sealed record through save() then load(), writing atomically via temp+rename", async () => {
    const fs = memoryFs();
    const store = new NodeFsKeyStateStore("/state/jev", fs);
    const record = { sealedKey: { namespace: "@marshal/jev", sealed: "opaque-blob" } };
    await store.save(record);
    expect(Object.keys(fs.files)).toEqual(["/state/jev/key.json"]);
    await expect(store.load()).resolves.toEqual(record);
  });
});

describe("MemoryKeyStateStore", () => {
  it("starts empty and round-trips a saved record", async () => {
    const store = new MemoryKeyStateStore();
    await expect(store.load()).resolves.toEqual(EMPTY_KEY_STATE);
    const record = { sealedKey: { namespace: "ns", sealed: "blob" } };
    await store.save(record);
    await expect(store.load()).resolves.toEqual(record);
  });
});
