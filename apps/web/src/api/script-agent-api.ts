/**
 * Script-agent RPC stream client (AGENT_SHELL_PLAN, Wave 4 / AS-8b) — the
 * `script` kind's transport twin of `experience-copilot-api.ts`.
 *
 * ROUTING NOTE: agent THREADS live in ONE shared store regardless of kind, so
 * the lifecycle endpoints (active/session/sessions/messages/activate/title/
 * context-links) are the SAME routes the experience client calls — they serve
 * every thread and never kind-check. Only the STREAM is kind-specific: since
 * AS-8b `POST /api/experience-copilot/:threadId/stream` DISPATCHES by the
 * thread's script row (prompt/dice → the `script` kind's assembly + tools), so
 * script threads stream through it too (pre-AS-8b they were refused with a 400
 * `copilot_thread_kind_mismatch`). This module exists so the script HOST
 * never imports the experience client — the kind's transport fns have their
 * own names and one home, exactly like the experience host's.
 *
 * The SSE event vocabulary is the shared agent one (`text-delta`,
 * `reasoning-delta`, `tool-call`, `tool-result`, `finish`, `error`, `abort`),
 * so `streamChatEndpoint` consumes it unchanged. The request body is the
 * shared `ExperienceCopilotStreamRequest` (AS-6c deferred per-kind wire
 * types); the script kind reads `code`/`scriptKind`/`codeSaved` and ignores
 * the experience-only fields.
 */
import { streamChatEndpoint } from "./stream.js";
import type { StreamOpts } from "./stream.js";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import type {
  ExperienceCopilotStreamRequest,
  ExperienceCopilotStreamAnswer,
  ExperienceCopilotThreadWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotContextLink,
} from "@vibe-tavern/api-contracts";

/** Stream opts for the agent stream endpoint — `StreamOpts` without the
 *  co-author module/skill callback (agents have no module/skill concept). */
export type ScriptAgentStreamOpts = Omit<StreamOpts, "onCoauthorModule">;

/** Stream one script-agent turn for a thread (the send path). */
export const streamScriptAgent = (
  threadId: string,
  body: ExperienceCopilotStreamRequest,
  opts: ScriptAgentStreamOpts,
) => streamChatEndpoint(`/api/experience-copilot/${threadId}/stream`, body, opts);

/** The answer payload for a pending `ask_user` question, minus the
 *  `toolCallId` the caller supplies. */
export type ScriptAgentAskAnswerInput = Omit<ExperienceCopilotStreamAnswer, "toolCallId">;

/** Answer a pending `ask_user` question (TAG-5 split-turn, style B): POSTs the
 *  SAME stream endpoint with the `answer` body instead of `content` — the
 *  answer replaces the awaiting tool-result row server-side (no new user row)
 *  and the turn resumes as a continuation. Delegates to
 *  {@link streamScriptAgent}, so the SSE consumption is the send path's. */
export const answerScriptAgentAsk = (
  threadId: string,
  request: Omit<ExperienceCopilotStreamRequest, "content" | "answer"> & { answer: ExperienceCopilotStreamAnswer },
  opts: ScriptAgentStreamOpts,
) => streamScriptAgent(threadId, request, opts);

// ─── Lifecycle REST methods (the SHARED thread store's kind-agnostic routes) ──

/** The single active thread for a script, or null when none exists. */
export async function getScriptAgentActive(
  scriptId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"].script[":scriptId"].active.$get({
    param: { scriptId },
  });
  return unwrapRpc(response);
}

/** All messages for a thread, oldest → newest. */
export async function listScriptAgentMessages(
  threadId: string,
): Promise<ExperienceCopilotMessageWire[]> {
  const response = await client.api["experience-copilot"][":threadId"].messages.$get({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Archive the current active thread (if any) and start a fresh one. */
export async function startScriptAgentSession(
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
export async function listScriptAgentSessions(
  scriptId: string,
): Promise<ExperienceCopilotThreadWire[]> {
  const response = await client.api["experience-copilot"].script[":scriptId"].sessions.$get({
    param: { scriptId },
  });
  return unwrapRpc(response);
}

/** Resume an archived session (archiving its active sibling, if any), or a
 *  no-op when already active. Returns null when the thread does not exist. */
export async function activateScriptAgentSession(
  threadId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].activate.$post({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Rename a session (empty title clears to the auto-numbered fallback).
 *  Returns null when the thread does not exist. */
export async function renameScriptAgentSession(
  threadId: string,
  title: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].title.$patch({
    param: { threadId },
    json: { title },
  });
  return unwrapRpc(response);
}

/** Full-replace a thread's pinned-context links (max 64, schema-enforced). */
export async function setScriptAgentContextLinks(
  threadId: string,
  links: ExperienceCopilotContextLink[],
): Promise<ExperienceCopilotContextLink[]> {
  const response = await client.api["experience-copilot"][":threadId"]["context-links"].$patch({
    param: { threadId },
    json: { links },
  });
  return unwrapRpc(response);
}

// ─── Turn delete (AP-10) ────────────────────────────────────────────────────
//
// The twin of the experience client's `deleteCopilotTurn` — the SAME shared
// thread-store route (threads live in one store regardless of kind, so the
// delete dispatches by thread, never kind-checks). The script host wires
// THIS fn (never the experience client) — the twin-module rule from the
// header above.

/** POST `/turns/delete` response (AP-8): every deleted row id in timeline
 *  order (the user row included when it was deleted), plus which of them was
 *  the user row. The twin of the experience client's
 *  `ExperienceCopilotTurnDeleteResult` (structurally identical — the
 *  registry's `deleteTurn` member stays one spelling through the
 *  experience client's `typeof`). */
export interface ScriptAgentTurnDeleteResult {
  deletedMessageIds: string[];
  deletedUserMessageId: string | null;
}

/** Delete the turn resolved around `messageId` (AP-8 route, AP-10 client).
 *  Same contract as the experience twin: the caller refetches on settle,
 *  no optimistic removal. */
export async function deleteScriptAgentTurn(
  threadId: string,
  body: { messageId: string; includeUserMessage: boolean },
): Promise<ScriptAgentTurnDeleteResult> {
  const response = await client.api["experience-copilot"][":threadId"].turns.delete.$post({
    param: { threadId },
    json: body,
  });
  return unwrapRpc(response);
}
