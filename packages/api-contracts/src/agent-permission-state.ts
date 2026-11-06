/**
 * ONE decoder for split-turn permission presentation state (DMT-11): a
 * permission tool's NAME plus its persisted tool-result output, decoded into
 * the typed `AgentPermissionState` the permission card renders — for BOTH
 * ingestion paths (persisted history rows and live/replayed SSE results).
 * History and live ingestion must consume THIS module; a second permission
 * parser on the web (or a second list of permission-tool names anywhere) is a
 * defect from copy #2.
 *
 * Family dispatch is on the TOOL NAME alone:
 * - `read_message_prompt` (SC-23e/SC-23f, the legacy permission tool) →
 *   `kind: "prompt_read"`. This arm replicates the web's
 *   `parseAgentPermissionState`
 *   (apps/web/src/stores/agent-turn-store.ts — counted fork #1) byte-for-byte;
 *   DMT-31 retires that copy and points both web ingestion paths here.
 * - `request_message_swipe` (DIRECTOR_MESSAGE_TOOLS_PLAN) → `kind: "swipe"`.
 *
 * Because `kind` is derived from the name, a prompt read can never become a
 * swipe merely because a client (or a corrupted row) sends an `instruction`
 * field: the prompt-read arm does not read `instruction`/`messageId`/
 * `variantId` at all, so those keys cannot alter its decode.
 *
 * The decode is DEFENSIVE (pure, never throws): persisted outputs are
 * structured state written by the server's own marker schemas, but a
 * malformed or foreign row must degrade to `null` (the caller renders the
 * error-card branch) — the same contract the web parser has always had.
 * Required fields are exactly those the card cannot render without; optional
 * identity fields are read leniently (a resolved row keeps "whatever identity
 * it kept").
 */

import type { AgentPermissionState } from "./schemas/agent-review-round-schema.js";

/**
 * Every tool name the permission family dispatches on, in stable definition
 * order — THE single list of permission-tool names. The backend's own
 * spelling constants (`SIDECHAT_PROMPT_READ_TOOL_NAME` in services/api; the
 * swipe builder in DMT-21) must stay equal to these; later units wire their
 * consumers through this module rather than re-listing names.
 */
export const AGENT_PERMISSION_TOOL_NAMES = [
  "read_message_prompt",
  "request_message_swipe",
] as const;

/** The wire name of one permission-family tool. */
export type AgentPermissionToolName = (typeof AGENT_PERMISSION_TOOL_NAMES)[number];

/** Which permission family a decoded state describes. */
export type AgentPermissionKind = NonNullable<AgentPermissionState["kind"]>;

/** A decoded permission state: the presentation shape plus the family, which
 * the decoder always sets (the raw type leaves it optional for legacy rows). */
export type DecodedAgentPermissionState = AgentPermissionState & {
  kind: AgentPermissionKind;
};

/** Is this tool name a permission-family tool? (The names list is above —
 * never re-derive it at a call site.) */
export function isAgentPermissionToolName(toolName: string): toolName is AgentPermissionToolName {
  return (AGENT_PERMISSION_TOOL_NAMES as readonly string[]).includes(toolName);
}

// ─── Structural reads (the web parser's exact semantics) ─────────────────────

/** Structural read of a record field as a string (undefined when absent or
 *  not a string — empty strings count as present; the callers decide). */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** Structural read of a record field as a non-negative integer (undefined
 *  when absent, non-integer, or negative) — the permission markers' numeric
 *  fields (`position`, `variantNumber`, `promptTokens`). */
function readNonNegativeInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** The common identity/display fields, read leniently (present-or-valid only). */
function identityFieldsOf(out: Record<string, unknown>) {
  const position = readNonNegativeInt(out, "position");
  const variantNumber = readNonNegativeInt(out, "variantNumber");
  const replyFirstLine = readString(out, "replyFirstLine");
  const presetName = readString(out, "presetName");
  const messageId = readString(out, "messageId");
  const variantId = readString(out, "variantId");
  return {
    ...(position !== undefined ? { position } : {}),
    ...(variantNumber !== undefined ? { variantNumber } : {}),
    ...(replyFirstLine !== undefined ? { replyFirstLine } : {}),
    ...(presetName !== undefined ? { presetName } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
  };
}

// ─── The two family arms ──────────────────────────────────────────────────────

/** The `read_message_prompt` arm: the awaiting marker requires the card's
 *  rendered fields (first line, variant number, token estimate); the granted/
 *  denied rewrites need only their status. Reads NONE of the swipe fields —
 *  an `instruction` key in a prompt-read output is never copied into the
 *  decoded state, so a prompt read cannot present as a swipe. */
function decodePromptReadState(output: unknown): DecodedAgentPermissionState | null {
  if (typeof output !== "object" || output === null) return null;
  const out = output as Record<string, unknown>;
  const position = readNonNegativeInt(out, "position");
  const variantNumber = readNonNegativeInt(out, "variantNumber");
  const replyFirstLine = readString(out, "replyFirstLine");
  const promptTokens = readNonNegativeInt(out, "promptTokens");
  const presetName = readString(out, "presetName");
  if (out.status === "awaiting_permission") {
    // The card names the reply by its first line and numbers it — a marker
    // missing those (or the token estimate) cannot render, so it is malformed.
    if (replyFirstLine === undefined || replyFirstLine === "" || variantNumber === undefined || promptTokens === undefined) return null;
    return {
      status: "awaiting_permission",
      kind: "prompt_read",
      ...(position !== undefined ? { position } : {}),
      variantNumber,
      replyFirstLine,
      promptTokens,
      ...(presetName !== undefined ? { presetName } : {}),
    };
  }
  if (out.status === "granted" || out.status === "denied") {
    return {
      status: out.status,
      kind: "prompt_read",
      ...(position !== undefined ? { position } : {}),
      ...(variantNumber !== undefined ? { variantNumber } : {}),
      ...(replyFirstLine !== undefined ? { replyFirstLine } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(presetName !== undefined ? { presetName } : {}),
    };
  }
  return null;
}

/** The `request_message_swipe` arm: the awaiting marker requires the reply
 *  identification plus the PROPOSED instruction in full (the card shows and
 *  edits it without opening any accordion); the granted receipt requires the
 *  FINAL user-approved instruction text (a granted row without one is
 *  malformed — the receipt must carry what the generation ran with); the
 *  denied receipt is the mechanism's pinned `{ status: "denied" }` plus
 *  whatever identity the row kept. */
function decodeSwipeState(output: unknown): DecodedAgentPermissionState | null {
  if (typeof output !== "object" || output === null) return null;
  const out = output as Record<string, unknown>;
  const identity = identityFieldsOf(out);
  const instruction = readString(out, "instruction");
  if (out.status === "awaiting_permission") {
    if (
      instruction === undefined ||
      instruction === "" ||
      identity.replyFirstLine === undefined ||
      identity.replyFirstLine === "" ||
      identity.variantNumber === undefined
    ) {
      return null;
    }
    return { status: "awaiting_permission", kind: "swipe", ...identity, instruction };
  }
  if (out.status === "granted") {
    if (instruction === undefined || instruction === "") return null;
    return { status: "granted", kind: "swipe", ...identity, instruction };
  }
  if (out.status === "denied") {
    return { status: "denied", kind: "swipe", ...identity };
  }
  return null;
}

/**
 * Decode ONE permission tool result: `toolName` plus the persisted tool-result
 * output → the typed presentation state, or `null` when the tool is not a
 * permission tool or the output is malformed for its family (the caller
 * renders the error-card branch). Never throws.
 */
export function decodeAgentPermissionState(
  toolName: string,
  output: unknown,
): DecodedAgentPermissionState | null {
  if (toolName === "read_message_prompt") return decodePromptReadState(output);
  if (toolName === "request_message_swipe") return decodeSwipeState(output);
  return null;
}
