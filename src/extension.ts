import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { JEV_CLIENT_SERVICE_TOKEN } from "./api.js";
import { createJevCapabilityProvider } from "./capabilities.js";
import { createJevClient } from "./client.js";
import { createJevConnectionUi } from "./connection-ui.js";
import type { InjectedRuntimeSecretsModule } from "./credentials.js";
import { KeyStore } from "./credentials.js";
import type {
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
  RuntimeExtensionConfiguration,
  RuntimeExtensionModule,
} from "./extensionProtocol.js";
import { NodeFsKeyStateStore, type StateFsPrimitives } from "./state/keyStateStore.js";
import { nodeFetch } from "./transport.js";

/**
 * dist/runtime.cjs entrypoint (runtime-extension.json). Wires the real
 * production transport (global `fetch` against api.typesafe.ai), the real
 * injected `@marshal/runtime-secrets` MODULE, and production sealed-key-state
 * persistence under `stateDir`. Exercised by unit tests against a fake
 * activation context and injectable seams, never against the real network or
 * real filesystem — mirrors code-review-ext/packages/github-core/src/extension.ts.
 */
export interface JevExtensionConfiguration extends RuntimeExtensionConfiguration {
  readonly defaultModel?: string;
  readonly apiBaseUrl?: string;
  /** Sealed-key-state persistence root; defaults to `.marshal-state/jev`. */
  readonly stateDir?: string;
}

const DEFAULT_STATE_DIR = ".marshal-state/jev";

function nodeStateFsAdapter(): StateFsPrimitives {
  return {
    readFile: (path, encoding) => readFile(path, encoding),
    writeFile: async (path, data, encoding) => {
      await writeFile(path, data, encoding);
    },
    rename: async (oldPath, newPath) => {
      await rename(oldPath, newPath);
    },
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
  };
}

/**
 * Real host-injected secrets module resolution — see
 * code-review-ext/packages/github-core/src/extension.ts's identical
 * `resolveInjectedRuntimeSecretsModule` for the full rationale. Fails closed
 * (returns `undefined`) on absence, a throw, or a malformed shape.
 */
export function resolveInjectedRuntimeSecretsModule(loadModule: () => unknown): InjectedRuntimeSecretsModule | undefined {
  let candidate: unknown;
  try {
    candidate = loadModule();
  } catch {
    return undefined;
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as Partial<InjectedRuntimeSecretsModule>).isAvailable !== "function" ||
    typeof (candidate as Partial<InjectedRuntimeSecretsModule>).seal !== "function" ||
    typeof (candidate as Partial<InjectedRuntimeSecretsModule>).open !== "function"
  ) {
    return undefined;
  }
  return candidate as InjectedRuntimeSecretsModule;
}

/**
 * Production wiring only: a literal `require("@marshal/runtime-secrets")`
 * call, marked `external` in build.mjs so esbuild leaves it exactly here,
 * evaluated lazily inside `resolveInjectedRuntimeSecretsModule`'s own
 * try/catch so a host that hasn't wired this module never crashes the whole
 * bundle load — only this one resolution fails closed to `undefined`.
 */
function loadProductionRuntimeSecretsModule(): InjectedRuntimeSecretsModule | undefined {
  return resolveInjectedRuntimeSecretsModule(() => require("@marshal/runtime-secrets"));
}

const extensionModule: RuntimeExtensionModule<JevExtensionConfiguration> = {
  async activate(context: RuntimeExtensionActivationContext<JevExtensionConfiguration>): Promise<RuntimeExtensionActivation> {
    const runtimeSecrets = loadProductionRuntimeSecretsModule();
    const stateStore = new NodeFsKeyStateStore(context.configuration.stateDir ?? DEFAULT_STATE_DIR, nodeStateFsAdapter());
    const restoredState = await stateStore.load();

    const keyStore = new KeyStore({
      ...(runtimeSecrets ? { runtimeSecrets } : {}),
      // Field Guide-style export-on-change persistence (mirrors github-core's
      // `onSealedStateChanged`): best-effort, never throws into a caller of
      // `setKey`/`clear` — a disk-full or post-dispose write is swallowed.
      onSealedStateChanged: (sealedKey) => {
        void stateStore.save({ sealedKey }).catch(() => {});
      },
    });
    keyStore.restoreSealedState(restoredState.sealedKey);

    const handle = createJevClient({
      keyStore,
      fetchImpl: nodeFetch(),
      ...(context.configuration.defaultModel ? { defaultModel: context.configuration.defaultModel } : {}),
      ...(context.configuration.apiBaseUrl ? { apiBaseUrl: context.configuration.apiBaseUrl } : {}),
    });

    const { capabilityProvider: connectionCapabilityProvider, uiApplications } = createJevConnectionUi(context, handle);

    return {
      // Only the declared facade (`handle.client`) is ever bound at the
      // symbol — no internals, no key-store escape hatch reaches a consumer
      // holding Symbol.for('@marshal/jev:client').
      serviceContributions: [{ token: JEV_CLIENT_SERVICE_TOKEN, binding: { useValue: handle.client } }],
      capabilityProviders: [createJevCapabilityProvider(handle.client), connectionCapabilityProvider],
      uiApplications,
    };
  },
};

export const activate: RuntimeExtensionModule<JevExtensionConfiguration>["activate"] = (context) =>
  extensionModule.activate(context);

export default extensionModule;
