import { randomUUID } from "node:crypto";
import type { JevClientErrorCode, JevStatus } from "./api.js";
import type { JevClientHandle } from "./client.js";
import { JevClientError } from "./errors.js";
import type { RuntimeExtensionActivationContext, RuntimeExtensionUiApplication } from "./extensionProtocol.js";
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
} from "./runtimeProtocol.js";

const OWNER = "@marshal/jev";
const APPLICATION_ID = "jev-connect";
const PROTOCOL_VERSION = "1.0.0";

export const JEV_CONNECTION_CAPABILITIES = [
  "jev.connect",
  "jev.connection.save_key",
  "jev.connection.test",
  "jev.disconnect",
] as const;
export type JevConnectionCapability = (typeof JEV_CONNECTION_CAPABILITIES)[number];

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const SAVE_KEY_INPUT_SCHEMA = {
  type: "object",
  properties: { key: { type: "string", minLength: 1 } },
  required: ["key"],
  additionalProperties: false,
} as const;
const STATUS_MESSAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: { status: { type: "string" }, message: { type: "string" } },
  required: ["status", "message"],
  additionalProperties: false,
} as const;

const STATUS_BADGES: Record<JevStatus["state"], string> = {
  "not-connected": "Not connected",
  connected: "Connected",
  "invalid-key": "Invalid key",
  "rate-limited": "Rate limited",
  unavailable: "Unavailable",
};

function defaultMessageFor(status: JevStatus): string {
  switch (status.state) {
    case "not-connected":
      return "Connect an OpenAI API key to use Jev.";
    case "connected":
      return `Connected. Using model ${status.model}${status.source === "env" ? " (key from OPENAI_API_KEY)" : ""}.`;
    case "invalid-key":
      return status.detail ?? "The active API key was rejected. Paste a new one.";
    case "rate-limited":
      return status.detail ?? "OpenAI is rate-limiting this key right now. Try again shortly.";
    case "unavailable":
      return status.detail ?? "The OpenAI API is temporarily unavailable.";
  }
}

function toneFor(state: JevStatus["state"]): "info" | "danger" {
  return state === "connected" || state === "not-connected" ? "info" : "danger";
}

/** Maps a thrown `JevClientError` from a card action onto the card's displayed connection state, when it names one. */
function errorCodeToDisplayState(code: JevClientErrorCode): JevStatus["state"] | undefined {
  switch (code) {
    case "JEV_INVALID_KEY":
      return "invalid-key";
    case "JEV_RATE_LIMITED":
      return "rate-limited";
    case "JEV_UNAVAILABLE":
      return "unavailable";
    case "JEV_NOT_CONNECTED":
      return "not-connected";
    default:
      return undefined;
  }
}

// The key form, "Test connection" and "Disconnect" controls are chosen per status so the card never shows a dead control.
function connectionDocument(status: JevStatus, message: string) {
  const showKeyForm = status.state !== "connected" && status.source !== "env";
  const showTest = status.source !== undefined;
  const showDisconnect = status.source === "stored";
  const children: unknown[] = [
    { type: "heading", id: "jev-title", text: "Connect Jev (OpenAI)", level: 3 },
    { type: "badge", id: "jev-state", text: STATUS_BADGES[status.state], tone: toneFor(status.state) },
    { type: "text", id: "jev-message", text: message, tone: toneFor(status.state) === "danger" ? "danger" : "muted" },
    { type: "divider", id: "jev-divider" },
    {
      type: "text",
      id: "jev-scope",
      text: "Sends the state/questions you (or an agent) provide to OpenAI. The API key is stored only on this machine and is never shown in chat.",
      tone: "muted",
    },
    ...(showKeyForm
      ? [
          {
            type: "text",
            id: "jev-key-hint",
            text: "Create a key at platform.openai.com/api-keys, then paste it here. It is verified before it is saved.",
            tone: "muted",
          },
          { type: "input", id: "jev-key-input", name: "key", label: "OpenAI API key", placeholder: "sk-..." },
          { type: "button", id: "jev-save-button", label: "Save key", actionId: "save" },
        ]
      : status.source === "env"
        ? [{ type: "text", id: "jev-env-note", text: "Key supplied by OPENAI_API_KEY; edit the environment variable to change it.", tone: "muted" }]
        : []),
    ...(showTest ? [{ type: "button", id: "jev-test-button", label: "Test connection", actionId: "test" }] : []),
    ...(showDisconnect ? [{ type: "button", id: "jev-disconnect-button", label: "Disconnect", actionId: "disconnect", variant: "danger" }] : []),
  ];
  return {
    protocolVersion: PROTOCOL_VERSION,
    title: "Connect Jev (OpenAI)",
    // An untitled card node renders as a bordered, always-expanded container; a titled one collapses.
    root: { type: "card", id: "jev-connect-card", children: [{ type: "stack", id: "jev-connect-body", gap: "small", children }] },
    actions: [
      { id: "save", operation: "jev.connection.save_key", input: {}, eventMap: { key: "key" } },
      { id: "test", operation: "jev.connection.test", input: {} },
      { id: "disconnect", operation: "jev.disconnect", input: {} },
    ],
  };
}

export function createJevConnectionUi(
  context: RuntimeExtensionActivationContext,
  handle: JevClientHandle,
): { capabilityProvider: CapabilityProvider; uiApplications: readonly RuntimeExtensionUiApplication[] } {
  const descriptors: readonly CapabilityDescriptor[] = JEV_CONNECTION_CAPABILITIES.map((name) => ({
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: "1.0.0",
    title:
      name === "jev.connect"
        ? "Connect Jev in chat"
        : name === "jev.connection.save_key"
          ? "Save Jev API key"
          : name === "jev.connection.test"
            ? "Test Jev connection"
            : "Disconnect Jev",
    description:
      name === "jev.connect"
        ? "Shows the Jev connection card in chat. Use when the user asks to connect Jev or its OpenAI key, or when jev.status reports anything other than connected."
        : name === "jev.connection.save_key"
          ? "Card-only action: verifies a pasted API key against GET /v1/models BEFORE storing it. The key never appears in chat output."
          : name === "jev.connection.test"
            ? "Card-only action: re-verifies the active key and refreshes the card."
            : "Card-only action: deletes the stored API key (an env-supplied key is unaffected).",
    tags: ["jev", "openai", "connect"],
    inputSchema: name === "jev.connection.save_key" ? SAVE_KEY_INPUT_SCHEMA : EMPTY_INPUT_SCHEMA,
    outputSchema: STATUS_MESSAGE_OUTPUT_SCHEMA,
    permissions: [
      {
        permission: `marshal.tool.invoke:${name}`,
        risk: name === "jev.connection.save_key" || name === "jev.disconnect" ? "medium" : "low",
        reason:
          name === "jev.connect"
            ? "Shows connection status in the current chat."
            : name === "jev.connection.save_key"
              ? "Writes a user-pasted API key to the local sealed credential store."
              : name === "jev.connection.test"
                ? "Re-verifies the active key against OpenAI."
                : "Deletes the stored API key.",
      },
    ],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  const execute = async (target: string, input: unknown, invocation: InvocationContext): Promise<any> => {
    if (!context.execute) throw new JevClientError("JEV_UNAVAILABLE", "The host does not support in-chat connection cards.");
    const result = await context.execute({ protocolVersion: PROTOCOL_VERSION, targetType: "operation", target, input }, invocation);
    if (result.status !== "success") {
      throw new JevClientError("JEV_UNAVAILABLE", result.error?.message || "Unable to show the connection card.");
    }
    return result.result?.output;
  };

  const publish = async (
    invocation: InvocationContext,
    actionError?: JevClientError,
  ): Promise<{ status: string; message: string }> => {
    const baseStatus = await handle.client.status();
    const overrideState = actionError ? errorCodeToDisplayState(actionError.code) : undefined;
    const status: JevStatus = overrideState ? { ...baseStatus, state: overrideState } : baseStatus;
    const message = actionError ? actionError.message : defaultMessageFor(status);
    const owner = { extensionId: OWNER, applicationId: APPLICATION_ID };
    const document = connectionDocument(status, message);
    // A card-originated action runs under the card's publication authority, which
    // can refresh its own instance but never create a new card; a failed refresh
    // must not mask the action's real outcome.
    try {
      const list = await execute("ui.application.list", { ...owner, surface: "inline-card" }, invocation);
      const existing = list?.instances?.find((instance: any) => instance.surface === "inline-card");
      await execute(
        existing ? "ui.application.update" : "ui.chat.card.show",
        { ...owner, ...(existing ? { instanceId: existing.instanceId } : {}), state: { document }, idempotencyKey: randomUUID() },
        invocation,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { status: status.state, message: `${message} (Card refresh failed: ${reason})` };
    }
    return { status: status.state, message };
  };

  const capabilityProvider: CapabilityProvider = {
    id: "jev.connections",
    version: "1.0.0",
    list: () => descriptors,
    get: (name) => byName.get(name),
    async invoke(name, input, invocation): Promise<CapabilityInvocationResult> {
      if (!byName.has(name)) throw new JevClientError("JEV_BAD_REQUEST", `Unknown connection action "${name}".`);
      let actionError: JevClientError | undefined;
      try {
        if (name === "jev.connection.save_key") {
          const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
          if (typeof record.key !== "string" || !record.key.trim()) {
            throw new JevClientError("JEV_BAD_REQUEST", "A non-empty 'key' is required.");
          }
          await handle.saveKey(record.key);
        } else if (name === "jev.connection.test") {
          await handle.testConnection();
        } else if (name === "jev.disconnect") {
          await handle.disconnect();
        }
        // jev.connect itself takes no action beyond publishing the current status below.
      } catch (error) {
        actionError =
          error instanceof JevClientError
            ? error
            : new JevClientError("JEV_UNAVAILABLE", error instanceof Error ? error.message : "The action failed.");
      }
      return { output: await publish(invocation, actionError) };
    },
  };

  const uiApplications: readonly RuntimeExtensionUiApplication[] = [
    {
      id: APPLICATION_ID,
      title: "Connect Jev (OpenAI)",
      description: "Connect an OpenAI API key for Jev and return to this chat.",
      renderId: "jev.connections.v1",
      resource: { uri: "jev-runtime://connections/jev", mimeType: "text/plain", text: "" },
      application: {
        version: "1.0.0",
        presentationModes: ["inline"],
        tools: [],
        actions: descriptors
          .filter((descriptor) => descriptor.name !== "jev.connect")
          .map((descriptor) => ({
            id: descriptor.name.replace(/\./g, "_"),
            version: "1.0.0",
            title: descriptor.title,
            target: { kind: "capability", capability: descriptor.name },
            inputSchema: descriptor.inputSchema,
            outputSchema: descriptor.outputSchema,
            allowedScopes: ["session"],
            requiredPermissions: [],
            risk: descriptor.name === "jev.connection.save_key" || descriptor.name === "jev.disconnect" ? "external-effect" : "read",
            idempotency: "supported",
          }))
          .concat(
            // Card actions refresh their own card; the host authorizes own-application
            // ui.application.* calls only when the publication declares them.
            (["list", "update"] as const).map((verb) => ({
              id: `ui_application_${verb}`,
              version: "1.0.0",
              title: verb === "list" ? "Find this card" : "Refresh this card",
              target: { kind: "capability", capability: `ui.application.${verb}` },
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              allowedScopes: ["session"],
              requiredPermissions: [],
              risk: verb === "list" ? "read" : "write",
              idempotency: "supported",
            })),
          ),
      },
      tags: ["jev", "openai", "connect"],
      // Phone-friendly declarative card (~390px width). Per
      // docs/architecture/MOBILE-RUNTIME-UI.md / common/runtime-ui-viewports.ts
      // an undeclared surface is desktop-only — this MUST be explicit.
      metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
    },
  ];

  return { capabilityProvider, uiApplications };
}
