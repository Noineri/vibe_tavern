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
  ExperienceCopilotThreadWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotContextMetrics,
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
  return unwrapRpc<ExperienceCopilotThreadWire | null>(response);
}

/** All messages for a thread, oldest → newest. */
export async function listExperienceCopilotMessages(
  threadId: string,
): Promise<ExperienceCopilotMessageWire[]> {
  const response = await client.api["experience-copilot"][":threadId"].messages.$get({
    param: { threadId },
  });
  return unwrapRpc<ExperienceCopilotMessageWire[]>(response);
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
  return unwrapRpc<ExperienceCopilotThreadWire>(response);
}

/** All sessions (active + archived) for a script, newest first. */
export async function listExperienceCopilotSessions(
  scriptId: string,
): Promise<ExperienceCopilotThreadWire[]> {
  const response = await client.api["experience-copilot"].script[":scriptId"].sessions.$get({
    param: { scriptId },
  });
  return unwrapRpc<ExperienceCopilotThreadWire[]>(response);
}

/** Resume an archived session (archiving its active sibling, if any), or a
 *  no-op when already active. Returns null when the thread does not exist. */
export async function activateExperienceCopilotSession(
  threadId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].activate.$post({
    param: { threadId },
  });
  return unwrapRpc<ExperienceCopilotThreadWire | null>(response);
}

/** Archive a single session (idempotent). Returns null when the thread does
 *  not exist. */
export async function archiveExperienceCopilotSession(
  threadId: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api["experience-copilot"][":threadId"].archive.$post({
    param: { threadId },
  });
  return unwrapRpc<ExperienceCopilotThreadWire | null>(response);
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
  return unwrapRpc<ExperienceCopilotContextState>(response);
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
  return unwrapRpc<ExperienceCopilotContextState>(response);
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
  return unwrapRpc<ExperienceCopilotCompactResult>(response);
}
