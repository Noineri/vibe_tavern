/**
 * The assembled-prompt → SDK fold (extracted from `agent-stream.ts`
 * verbatim-where-touched — DMT-23: the loop file sat at the arch-gate cap and
 * the unit's seam extension needed headroom; extraction is the sanctioned
 * remedy, a re-export seam keeps every `agent-stream.js` importer stable).
 *
 * `AgentPromptMessage` — one message in a kind's assembled prompt (the shape
 * the generic loop's folds consume); `toModelMessages` — the SDK fold the
 * streaming turn passes to `prepareAgentModelMessages` as its `convert`.
 */

import type { ModelMessage, AssistantContent, ToolCallPart, ToolResultPart } from "ai";
import type { Attachment } from "@vibe-tavern/domain";

/** One message in a kind's assembled prompt (system + compacted history) —
 *  the shape the generic `toModelMessages` fold consumes. */
export type AgentPromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; attachments?: Attachment[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };

/** Convert the assembled prompt messages into AI SDK `ModelMessage[]`.
 *  Mirrors `prepareSdkMessages`'s assistant branch: the SDK has NO top-level
 *  `toolCalls` field on an assistant message — tool calls live INSIDE `content`
 *  as `ToolCallPart[]` (AssistantContent) — without this fold the SDK silently
 *  ignores them and the model loses its cross-turn tool-call context. */
export function toModelMessages(
  messages: ReadonlyArray<AgentPromptMessage>,
): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: msg.content };
      case "assistant": {
        if (msg.toolCalls?.length) {
          const parts: AssistantContent = [...msg.toolCalls];
          if (msg.content) parts.push({ type: "text", text: msg.content });
          return { role: "assistant", content: parts };
        }
        return { role: "assistant", content: msg.content };
      }
      case "tool":
        return { role: "tool", content: msg.content };
    }
  });
}
