/**
 * Structural mirror of the `@marshal/agent-runtime-extensions` activation
 * contract (RuntimeExtensionModule / RuntimeExtensionActivationContext /
 * RuntimeExtensionActivation / service contribution shapes / ui applications)
 * that this package's dist/runtime.cjs entrypoint conforms to.
 *
 * Kept local for the same reason as runtimeProtocol.ts: build/typecheck for
 * this package never require the unpublished reference checkout to be
 * present.
 */

import type { CapabilityProvider } from "./runtimeProtocol.js";

export type RuntimeExtensionConfiguration = Readonly<Record<string, unknown>>;

export interface RuntimeServiceAccessor {
  get<T>(token: symbol): T;
  tryGet<T>(token: symbol): T | undefined;
  getAll<T>(token: symbol): readonly T[];
}

export interface RuntimeServiceValueBinding<T> {
  readonly useValue: T;
}

export interface RuntimeExtensionServiceContribution<T = unknown> {
  readonly token: symbol;
  readonly binding: RuntimeServiceValueBinding<T>;
  readonly mode?: "bind" | "replace" | "many";
}

/** Mirrors `RuntimeExtensionUiApplication` (agent-runtime-extensions/src/contracts.ts). */
export interface RuntimeExtensionUiApplication {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly renderId: string;
  readonly resource: {
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
  };
  readonly application: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  /**
   * `marshal.ui.viewports` lives here (docs/architecture/MOBILE-RUNTIME-UI.md,
   * common/runtime-ui-viewports.ts) — undeclared surfaces are desktop-only,
   * so the connection card explicitly declares `["mobile", "desktop"]`.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionActivationContext<
  TConfiguration extends RuntimeExtensionConfiguration = RuntimeExtensionConfiguration,
> {
  readonly configuration: Readonly<TConfiguration>;
  readonly services: RuntimeServiceAccessor;
  /** Present when the host supports in-chat declarative UI (connection cards). */
  readonly execute?: (
    request: Readonly<Record<string, unknown>>,
    context: import("./runtimeProtocol.js").InvocationContext,
  ) => Promise<{
    readonly status: "success" | "error";
    readonly error?: { readonly message?: string };
    readonly result?: { readonly output?: any };
  }>;
  readonly manifest?: { readonly version: string };
}

export interface RuntimeExtensionActivation {
  readonly serviceContributions?: readonly RuntimeExtensionServiceContribution[];
  readonly capabilityProviders?: readonly CapabilityProvider[];
  readonly uiApplications?: readonly RuntimeExtensionUiApplication[];
  readonly dispose?: () => void | Promise<void>;
}

export interface RuntimeExtensionModule<
  TConfiguration extends RuntimeExtensionConfiguration = RuntimeExtensionConfiguration,
> {
  activate(
    context: RuntimeExtensionActivationContext<TConfiguration>,
  ): RuntimeExtensionActivation | Promise<RuntimeExtensionActivation>;
}
