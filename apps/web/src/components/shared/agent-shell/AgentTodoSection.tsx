import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import { agentThreadKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { AgentTodoPanel } from "./AgentTodoPanel.js";

/**
 * AgentTodoSection (PM-7, EXPERIENCE_COPILOT_PLAN_MODE_PLAN — owner ruling
 * 2026-10-11; AS-6b2 moved from the copilot editors' CopilotTodoSection)
 * — the agent shell's mount of the session-scoped todo
 * mechanic, restored to live BESIDE the script-owned plan: todo = the
 * thread's session checklist; plan = the script's durable document. The todo
 * twin of `AgentPlanSection` (extracted for the same arch-gate file
 * ratchet when the mechanic came back).
 *
 * Owns the turn-store subscription for the thread's checklist: the store's
 * `todoByThread[threadId]` is the live source of truth (seeded from the
 * thread wire by the controller, rewritten live by `todo` tool events). The
 * panel hides itself while the list is empty; placement contract — pinned
 * directly below `AgentContextMeter` and directly ABOVE
 * `AgentPlanSection`, never scrolling with the feed.
 */

// TAG-8 (restored PM-7): stable empty for the todo panel selector
// (reference-stable so an absent checklist never re-renders the panel).
const EMPTY_TODO: readonly CopilotTodoItem[] = [];

export function AgentTodoSection({ kind, threadId }: { kind: AgentKind; threadId: string | null }) {
  // TAG-8: the session-scoped checklist for the pinned todo panel. The store
  // replaces the array immutably per rewrite — a reference selector is exact.
  const items = useAgentTurnStore((s) =>
    threadId ? s.todoByThread[agentThreadKey(kind, threadId)] ?? EMPTY_TODO : EMPTY_TODO,
  );
  return <AgentTodoPanel items={items} />;
}
