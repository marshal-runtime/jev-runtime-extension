import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(packageRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(packageRoot, "src", "extension.ts")],
  outfile: path.join(outputDirectory, "runtime.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  packages: "bundle",
  // '@marshal/runtime-secrets' is a backend-only MODULE the live host injects
  // into the loader's `require()` for verified extension bundles — it is
  // never resolvable from node_modules, so it must stay a literal
  // `require("@marshal/runtime-secrets")` in the built bundle rather than
  // something esbuild tries to inline (mirrors code-review-ext/packages/github-core).
  external: ["@marshal/runtime-secrets"],
  sourcemap: false,
  legalComments: "eof",
});

console.log("[jev] built dist/runtime.cjs");
