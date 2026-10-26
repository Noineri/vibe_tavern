/**
 * Agent-thread OWNERSHIP test (SIDECHAT_PLAN SC-0b/SC-0f) — extracted into
 * its own module when `agent-stream.ts` hit the 800-line cap (the ratchet's
 * remedy is extraction, never trimming). Kept beside the stream module it
 * was born in (domain/agent/), structural like `AgentStreamThread`: the
 * concrete per-kind thread type satisfies the parameter without adapters.
 */

/** Is this agent thread CHAT-OWNED (born from a chat branch, its agent kind
 *  stored on the row — the ER-3 store writes chatId / branchId / agentKind
 *  together, so any two of them decide)? The owner test the kind streams'
 *  profile-resolution hop uses to pick the chat-owned chain
 *  (`resolveProfileForChat`) over the script path (`resolveProfile`). Also a
 *  type predicate: on `true` the owner columns are non-null. */
export function isChatOwnedAgentThread(
  thread: { readonly chatId: string | null; readonly agentKind: string | null },
): thread is { readonly chatId: string; readonly agentKind: string } {
  return thread.chatId !== null && thread.agentKind !== null;
}
