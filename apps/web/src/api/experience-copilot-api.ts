/**
 * Experience-Copilot RPC stream client (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 2 / ER-10b).
 *
 * Thin wrapper over the shared `streamChatEndpoint` SSE helper. The copilot
 * endpoint (`POST /api/experience-copilot/:threadId/stream`) emits the SAME SSE
 * event vocabulary as the chat stream (`text-delta`, `reasoning-delta`,
 * `tool-call`, `tool-result`, `finish`, `error`, `abort`) — a strict subset —
 * so `streamChatEndpoint` → `parseSSEStream` consumes it unchanged, with no
 * new parser or event plumbing. The only difference is the request body
 * (`ExperienceCopilotStreamRequest`: `{ content, providerProfileId, model?,
 * step?, testFeedback? }`) and the absence of the co-author module/skill
 * concept (`onCoauthorModule` is simply omitted from the opts and never fires).
 */
import { streamChatEndpoint } from "./stream.js";
import type { StreamOpts } from "./stream.js";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import type {
  ExperienceCopilotStreamRequest,
  ExperienceCopilotStreamAnswer,
  ExperienceCopilotStreamAskAnswer,
  ExperienceCopilotThreadWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotContextMetrics,
  ExperienceCopilotContextLink,
} from "@vibe-tavern/api-contracts";

/** Stream opts for the copilot endpoint — `StreamOpts` without the co-author
 *  module/skill callback (the copilot has no module/skill concept, so
 *  `onCoauthorModule` is simply never fired). */
export type CopilotStreamOpts = Omit<StreamOpts, "onCoauthorModule">;

/** Stream one experience-copilot turn for a thread. */
export const streamExperienceCopilot = (
  threadId: string,
  body: ExperienceCopilotStreamRequest,
  opts: CopilotStreamOpts,
) => streamChatEndpoint(`/api/experience-copilot/${threadId}/stream`, body, opts);

/** TAG-9: the answer payload for a pending `ask_user` question (TAG-5
 *  split-turn), minus the `toolCallId` the caller supplies — either `text`
 *  (a tapped chip's label or free text) or `skipped: true`, never both.
 *  Pinned to the ask MEMBER since SC-23e (the wire answer type became a
 *  union with the permission decision — this card's input stays the ask
 *  family; the permission sender is SC-23f's). */
export type CopilotAskAnswerInput = Omit<ExperienceCopilotStreamAskAnswer, "toolCallId">;

/** SC-23f: the permission decision for a pending `read_message_prompt`
 *  request (SC-23e split-turn), minus the `toolCallId` the caller supplies —
 *  `decision: "allow"` lets the model read the reply's exact prompt,
 *  `"deny"` continues the turn without it. The permission MEMBER of the
 *  wire answer union (narrowed by shape — the contracts package exports the
 *  union, not the member, so this derives it here and stays web-local). */
export type CopilotPermissionAnswerInput = Omit<
  Extract<ExperienceCopilotStreamAnswer, { decision: unknown }>,
  "toolCallId"
>;

/** SC-23f: either split-turn answer family — the ask input or the permission
 *  decision. The controller's answer path and the message list's `onAnswer`
 *  take this union (one path, no transport fork — `answerCopilotAsk` already
 *  carries the wire union); each card's submitter stays narrowed to its own
 *  family. */
export type CopilotAnswerInput = CopilotAskAnswerInput | CopilotPermissionAnswerInput;

/** Answer a pending `ask_user` question (TAG-5 split-turn, style B): POSTs
 *  the SAME stream endpoint with the `answer` body instead of `content` —
 *  the answer replaces the awaiting tool-result row server-side (no new
 *  user row) and the turn resumes as a continuation. Delegates to
 *  `streamExperienceCopilot`, so the SSE consumption is literally the send
 *  path's (no parser fork). */
export const answerCopilotAsk = (
  threadId: string,
  request: Omit<ExperienceCopilotStreamRequest, "content" | "answer"> & { answer: ExperienceCopilotStreamAnswer },
  opts: CopilotStreamOpts,
) => streamExperienceCopilot(threadId, request, opts);

// ─── Lifecycle REST methods (ER-11a) ────────────────────────────────────────
//
// Typed-RPC twins of the three ER-3 store lifecycle ops the copilot editor
// shell needs. Unlike the stream (raw-fetch SSE), these are ordinary REST calls
// through `client.api` (same pattern as experience-api.ts).

/** The single active thread for a script, or null when none exists. */
export async function getExperienceCopilotActive(
  scriptId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"].script[":scriptId"].active.$get({
    param: { scriptId },
  });
  return unwrapRpc(response);
}

/** All messages for a thread, oldest → newest. */
export async function listExperienceCopilotMessages(
  threadId: string,
): Promise<ExperienceCopilotMessageWire[]> {
  const response = await client.api["experience-copilot"][":threadId"].messages.$get({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Archive the current active thread (if any) and start a fresh one. */
export async function startExperienceCopilotSession(
  scriptId: string,
  title?: string,
): Promise<ExperienceCopilotThreadWire> {
  const response = await client.api["experience-copilot"].script[":scriptId"].session.$post({
    param: { scriptId },
    json: title ? { title } : {},
  });
  return unwrapRpc(response);
}

/** All sessions (active + archived) for a script, newest first. */
export async function listExperienceCopilotSessions(
  scriptId: string,
): Promise<ExperienceCopilotThreadWire[]> {
  const response = await client.api["experience-copilot"].script[":scriptId"].sessions.$get({
    param: { scriptId },
  });
  return unwrapRpc(response);
}

/** Resume an archived session (archiving its active sibling, if any), or a
 *  no-op when already active. Returns null when the thread does not exist. */
export async function activateExperienceCopilotSession(
  threadId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].activate.$post({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Archive a single session (idempotent). Returns null when the thread does
 *  not exist. */
export async function archiveExperienceCopilotSession(
  threadId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].archive.$post({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Rename a session (trim server-side; an empty title clears back to the
 *  auto-numbered fallback label). Returns null when the thread does not exist. */
export async function renameExperienceCopilotSession(
  threadId: string,
  title: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].title.$patch({
    param: { threadId },
    json: { title },
  });
  return unwrapRpc(response);
}

// ─── Context meter + compaction (CM-4/CM-5) ─────────────────────────────────

export interface ExperienceCopilotContextState {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
}

export interface ExperienceCopilotCompactResult {
  digest: ExperienceCopilotMessageWire;
  metrics: ExperienceCopilotContextMetrics;
}

/** Read a thread's last-turn metrics + auto-compact toggle (`metrics` is null
 *  before the first turn). */
export async function getExperienceCopilotContext(
  threadId: string,
): Promise<ExperienceCopilotContextState> {
  const response = await client.api["experience-copilot"][":threadId"].context.$get({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Toggle the thread's auto-compact flag. Returns the full context state. */
export async function patchExperienceCopilotContext(
  threadId: string,
  body: { autoCompact: boolean },
): Promise<ExperienceCopilotContextState> {
  const response = await client.api["experience-copilot"][":threadId"].context.$patch({
    param: { threadId },
    json: body,
  });
  return unwrapRpc(response);
}

/** Read a thread's pinned-context links (CX-1/CX-4). */
export async function getExperienceCopilotContextLinks(
  threadId: string,
): Promise<ExperienceCopilotContextLink[]> {
  const response = await client.api["experience-copilot"][":threadId"]["context-links"].$get({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Full-replace a thread's pinned-context links (max 64, schema-enforced). */
export async function setExperienceCopilotContextLinks(
  threadId: string,
  links: ExperienceCopilotContextLink[],
): Promise<ExperienceCopilotContextLink[]> {
  const response = await client.api["experience-copilot"][":threadId"]["context-links"].$patch({
    param: { threadId },
    json: { links },
  });
  return unwrapRpc(response);
}

/** Manually compact a thread (LLM summarize-and-replace). The digest message is
 *  appended at the end with its anchor in `toolCallId`; the caller refetches
 *  messages so the digest card appears at the boundary. Rejects with a 400 when
 *  there is nothing to compact, 409 when in-flight, 502 on provider error. */
export async function compactExperienceCopilot(
  threadId: string,
  body?: { providerProfileId?: string; model?: string },
): Promise<ExperienceCopilotCompactResult> {
  const response = await client.api["experience-copilot"][":threadId"].compact.$post({
    param: { threadId },
    json: body ?? {},
  });
  return unwrapRpc(response);
}

// ─── Turn delete (AP-10) ────────────────────────────────────────────────────

/** POST `/turns/delete` response (AP-8): every deleted row id in timeline
 *  order (the user row included when it was deleted), plus which of them was
 *  the user row. Mirrors the backend's `ExperienceCopilotTurnDeleteResult`
 *  (services/api contract — the backend-local twin, not an api-contracts
 *  wire type, so it is spelled here like `ExperienceCopilotCompactResult`). */
export interface ExperienceCopilotTurnDeleteResult {
  deletedMessageIds: string[];
  deletedUserMessageId: string | null;
}

/** Delete the turn resolved around `messageId` (AP-8 route, AP-10 client).
 *  The server resolves the ENCLOSING turn; `messageId` may point at any row
 *  of that turn, or at the user row itself (then only with
 *  `includeUserMessage: true`). The caller refetches messages on settle —
 *  there is no optimistic removal (the server owns the turn resolution).
 *  Rejects with a 400 on user-row semantics, 404 on an unknown thread or
 *  message, 409 at/below the digest floor. */
export async function deleteCopilotTurn(
  threadId: string,
  body: { messageId: string; includeUserMessage: boolean },
): Promise<ExperienceCopilotTurnDeleteResult> {
  const response = await client.api["experience-copilot"][":threadId"].turns.delete.$post({
    param: { threadId },
    json: body,
  });
  return unwrapRpc(response);
}

// ─── Assistant message edit (AP-30 route / AP-31 client) ──────────────────

/** Edit ONE assistant text row in place (AP-30 route, AP-31 client):
 *  PATCHes the addressed message's stored `content` with the replacement
 *  text — nothing regenerates (no model call), the row's id, createdAt, seq,
 *  and reasoning pair stay, every other row stays, and the updated message
 *  wire comes back. The caller refetches messages on settle (the delete's
 *  contract — no optimistic rewrite). Rejects with a typed 400
 *  (`not_assistant_row` / `tool_call_row` / `folded_row` / `empty_content` /
 *  `empty_row`) on an ineligible row and a 404 on an unknown thread or
 *  another thread's message — every agent kind calls the same route (no
 *  kind dispatch, like the delete above). */
export async function editCopilotMessage(
  threadId: string,
  messageId: string,
  content: string,
): Promise<ExperienceCopilotMessageWire> {
  const response = await client.api["experience-copilot"][":threadId"].messages[":messageId"].$patch({
    param: { threadId, messageId },
    json: { content },
  });
  return unwrapRpc(response);
}
