/**
 * Identifies which entity owns an agent thread (the shared agent-shell thread
 * table `experience_copilot_threads`). Threads were born script-owned (the
 * mini-app and script assistants); SIDECHAT_PLAN SC-0a adds chat-branch owners
 * so further agent kinds (the sidechat, later the director) can live on the
 * same machinery. Ownership is mutually exclusive per row and decides which
 * store methods and lifecycle routes serve the thread. The twin union of
 * `AgentPlanOwner` (agent-plan.ts) — the two owner unions of the agent shell.
 *
 * `agentKind` is the shared agent-kind registry slug (e.g. "sidechat-ooc") —
 * stored on the thread row itself for chat owners, because unlike a script
 * there is nothing to derive the kind from.
 */
export type AgentThreadOwner =
  | { kind: "script"; scriptId: string }
  | { kind: "chat"; chatId: string; branchId: string; agentKind: string };
