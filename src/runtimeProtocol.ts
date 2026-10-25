/**
 * Structural mirror of the `@marshal/agent-runtime-core` capability protocol
 * (CapabilityProvider / CapabilityDescriptor / InvocationContext /
 * CapabilityInvocationResult).
 *
 * Kept local (mirrors code-review-ext/packages/github-core/src/runtimeProtocol.ts)
 * so this package's build/typecheck never require the unpublished
 * `@marshal/agent-runtime-*` reference checkout to be present. TypeScript's
 * structural typing means a value shaped to these local interfaces satisfies
 * the real host contract without a physical dependency.
 */

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface CapabilityPermissionRequirement {
  readonly permission: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly risk?: "low" | "medium" | "high" | "critical";
}

/** Provider-authored, versioned description of one callable capability. */
export interface CapabilityDescriptor {
  readonly protocolVersion: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: JsonSchema;
  /** MUST be a closed explicit object: type "object", named properties, additionalProperties false. */
  readonly outputSchema: JsonSchema;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface RuntimePrincipal {
  readonly id: string;
  readonly kind: "agent" | "user" | "service" | string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface RuntimeAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface InvocationContext {
  readonly principal: RuntimePrincipal;
  readonly scope?: Readonly<Record<string, string | undefined>>;
  readonly executionId?: string;
  readonly signal?: RuntimeAbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Provider output. */
export interface CapabilityInvocationResult<TOutput = unknown> {
  readonly output: TOutput;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type MaybePromise<T> = T | Promise<T>;

export interface CapabilityProvider {
  readonly id: string;
  readonly version?: string;
  list(context: InvocationContext): MaybePromise<readonly CapabilityDescriptor[]>;
  get?(name: string, context: InvocationContext): MaybePromise<CapabilityDescriptor | undefined>;
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): MaybePromise<CapabilityInvocationResult>;
}
