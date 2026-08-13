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
import type { ExperienceCopilotStreamRequest } from "@vibe-tavern/api-contracts";

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
