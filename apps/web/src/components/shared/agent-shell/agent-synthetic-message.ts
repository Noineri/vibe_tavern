/**
 * Client-synthetic agent message rows (AGENT_SHELL_POLISH, AP-28) — the
 * `ExperienceCopilotMessageWire` literals the message list builds for rows
 * that have no stored counterpart yet (the pending user row, live streaming
 * text segments, the pending assistant block). Extracted from
 * `AgentMessageList.tsx` when AP-28's wire fields (reasoning pair) pushed that
 * file past the arch-gate size cap.
 *
 * The one place that knows a synthetic row carries NO server metadata: every
 * nullable column is `null`, `createdAt` is empty — the wire contract's
 * "absent, never undefined" discipline in a single derivation.
 */
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { Attachment } from "@vibe-tavern/domain";

/** The optimistic pending user row's id (CA-4f: exported so the block can
 *  render that row's chips WITHOUT the action menu — exactly like today's
 *  pending surfaces — while persisted rows get the «⋯» mount). */
export const PENDING_USER_MESSAGE_ID = "__pending-user";

export function syntheticAgentMessage(input: {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  /** CA-4e3: the optimistic user row's attachments (absent = none). */
  attachments?: readonly Attachment[];
}): ExperienceCopilotMessageWire {
  return {
    id: input.id,
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    ...(input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: [...input.attachments] }
      : {}),
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
  };
}
