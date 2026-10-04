/**
 * COAUTHOR_LORE_FULL_SETTINGS step 6 — the lore-work trigger.
 *
 * Owner ruling (2026-10-04, COAUTHOR_LORE_FULL_SETTINGS step 6): the full
 * lorebook schemas are shown ONLY while the Co-Author is working on the
 * lorebook — the full lore tool schemas reach the model
 * only while the Co-Author is actually working on lore. The trigger is derived
 * from state the backend ALREADY has at assembly time: the persisted chat
 * history, where every assistant tool call keeps its tool name
 * (`toolCallsJson`). "Working on lore" = the model's most recent working
 * segment (the assistant/tool messages after the previous user message)
 * contains at least one {@link LORE_TOOL_NAMES} call.
 *
 * Why this trigger (executor decision, logged in the report):
 *  - Zero model knowledge / zero extra round-trips to START lore work — the
 *    basic view already carries create-with-basics, lookup, content and keys,
 *    and the first lore call itself flips the set for the next assembly. An
 *    explicit "expand" tool would need the SAME next-request flip (tool
 *    schemas are fixed for the whole multi-step request) PLUS model knowledge
 *    of when to call it — strictly worse.
 *  - It flips back on its own: after one exchange without lore calls the
 *    segment is clean and the basic view returns (an "open draft" flag held in
 *    session state would not — the draft's lifecycle is frontend-owned and a
 *    reject never reaches the backend).
 *  - The just-sent user turn is skipped, so the trigger is order-independent:
 *    whether the current user message is already persisted at assembly time
 *    differs by flow and must never mask the previous segment's lore work.
 */
import { LORE_TOOL_NAMES } from "./lore-tools.js";

/**
 * Structural slice of an assembled history message — enough for the trigger,
 * without coupling to the prompt module's message type. Assistant messages
 * carry their tool calls as `toolCalls` (AI SDK `ToolCallPart` shape: the
 * tool NAME rides on `toolName`); user/tool rows never do.
 */
export interface LoreWorkHistoryMessage {
  role: "user" | "assistant" | "tool";
  toolCalls?: ReadonlyArray<{ toolName: string }>;
}

/**
 * Is the Co-Author currently working on lore, per the most-recent-working-
 * segment trigger? See the module header for the semantics and the rationale.
 */
export function isLoreWorkActive(messages: readonly LoreWorkHistoryMessage[]): boolean {
  const loreTools = new Set<string>(LORE_TOOL_NAMES);
  let i = messages.length - 1;
  // Skip the just-sent user turn(s) — see the module header.
  while (i >= 0 && messages[i]!.role === "user") i--;
  // The model's most recent working segment: everything back to (excluding)
  // the next user message. Multi-step assistant/tool rows are all in here.
  for (; i >= 0 && messages[i]!.role !== "user"; i--) {
    const calls = messages[i]!.toolCalls;
    if (calls !== undefined && calls.some((call) => loreTools.has(call.toolName))) return true;
  }
  return false;
}
