import type { JevClient } from "./api.js";
import { JevClientError } from "./errors.js";
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
} from "./runtimeProtocol.js";

export const JEV_CAPABILITY_PROVIDER_ID = "@marshal/jev";
const PROTOCOL_VERSION = "1.0.0";

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["choice", "score", "noul"] },
    criteria: { type: "object" },
    instructions: {},
  },
  required: ["type"],
  additionalProperties: false,
} as const;

const STATUS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["not-connected", "connected", "invalid-key", "rate-limited", "unavailable"] },
    model: { type: "string" },
    source: { type: "string", enum: ["env", "stored"] },
    lastVerifiedAt: { type: "string" },
    detail: { type: "string" },
  },
  required: ["state", "model"],
  additionalProperties: false,
} as const;

const MODEL_CARD_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    release_date: { type: "string" },
  },
  required: ["name", "description", "release_date"],
  additionalProperties: false,
} as const;

const MODELS_LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    models: { type: "array", items: MODEL_CARD_SCHEMA },
  },
  required: ["models"],
  additionalProperties: false,
} as const;

const ASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string" },
    state: {},
    questions: { type: "object", additionalProperties: QUESTION_SCHEMA },
  },
  required: ["state", "questions"],
  additionalProperties: false,
} as const;

const ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    // Per-question answer shape varies by question kind (choice/score/noul);
    // the dynamic data lives under this explicitly named property.
    answers: { type: "object", additionalProperties: true },
    model: { type: "string" },
    usage: {
      type: "object",
      properties: { input_tokens: { type: "number" }, output_tokens: { type: "number" } },
      required: ["input_tokens", "output_tokens"],
      additionalProperties: false,
    },
    latencyMs: { type: "number" },
  },
  required: ["answers", "model", "usage", "latencyMs"],
  additionalProperties: false,
} as const;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JevClientError("JEV_BAD_REQUEST", `${label} input must be an object.`);
  }
  return value as Record<string, unknown>;
}

function toResult<T>(output: T): CapabilityInvocationResult<T> {
  return { output };
}

/**
 * CapabilityProvider for the raw jev.* capabilities (status/models.list/ask).
 * The connection-card actions (jev.connect, jev.connection.save_key,
 * jev.connection.test, jev.disconnect) are a separate provider — see
 * connection-ui.ts — mirroring zyg-runtime-extension's split between
 * provider-facing capabilities and its connect-card actions.
 */
export function createJevCapabilityProvider(client: JevClient): CapabilityProvider {
  const descriptors: readonly CapabilityDescriptor[] = [
    {
      protocolVersion: PROTOCOL_VERSION,
      name: "jev.status",
      version: "1.0.0",
      title: "Read Jev connection status",
      description: "Reports whether Jev's OpenAI key is connected, and the active model. Never returns the key.",
      tags: ["jev", "openai", "status"],
      outputSchema: STATUS_OUTPUT_SCHEMA,
      permissions: [{ permission: "jev.status.read", risk: "low", reason: "Reads cached connection status only." }],
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      name: "jev.models.list",
      version: "1.0.0",
      title: "List available Jev models",
      description: "Calls GET /v1/models and lists the Jev model ids available to the connected account.",
      tags: ["jev", "openai", "models"],
      outputSchema: MODELS_LIST_OUTPUT_SCHEMA,
      permissions: [{ permission: "jev.models.read", risk: "low", reason: "Reads the model catalog from OpenAI." }],
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      name: "jev.ask",
      version: "1.0.0",
      title: "Ask Jev a structured question",
      description:
        "Asks OpenAI (structured output) about an arbitrary JSON state and one or more choice/score/noul questions; validates every answer before returning it.",
      tags: ["jev", "openai", "ask", "classification"],
      inputSchema: ASK_INPUT_SCHEMA,
      outputSchema: ASK_OUTPUT_SCHEMA,
      permissions: [
        { permission: "jev.ask.invoke", risk: "medium", reason: "Sends the caller-supplied state to OpenAI and spends usage budget." },
      ],
    },
  ];
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  return {
    id: JEV_CAPABILITY_PROVIDER_ID,
    version: "1.0.0",
    list: () => descriptors,
    get: (name) => byName.get(name),
    async invoke(name, input, _context: InvocationContext): Promise<CapabilityInvocationResult> {
      switch (name) {
        case "jev.status": {
          const status = await client.status();
          return toResult(status);
        }
        case "jev.models.list": {
          const models = await client.listModels();
          return toResult({ models: [...models] });
        }
        case "jev.ask": {
          const record = assertRecord(input, "jev.ask");
          if (record.state === undefined) throw new JevClientError("JEV_BAD_REQUEST", "jev.ask requires 'state'.");
          if (!record.questions || typeof record.questions !== "object" || Array.isArray(record.questions)) {
            throw new JevClientError("JEV_BAD_REQUEST", "jev.ask requires a 'questions' object.");
          }
          const result = await client.ask({
            ...(typeof record.model === "string" ? { model: record.model } : {}),
            state: record.state as never,
            questions: record.questions as never,
          });
          return toResult(result);
        }
        default:
          throw new JevClientError("JEV_BAD_REQUEST", `Unknown capability "${name}".`);
      }
    },
  };
}
