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

export function syntheticAgentMessage(input: {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
}): ExperienceCopilotMessageWire {
  return {
    id: input.id,
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
  };
}
