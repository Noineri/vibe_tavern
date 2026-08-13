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
