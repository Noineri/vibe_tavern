/**
 * Chat-owner agent-session client (SIDECHAT_PLAN SC-0c) — the typed twin of
 * the script lifecycle fns in `experience-copilot-api.ts` / `script-agent-api.ts`,
 * but against the SC-0b chat-owner routes:
 *
 *   GET  /api/agent/chats/:chatId/branches/:branchId/:kind/active
 *   GET  /api/agent/chats/:chatId/branches/:branchId/:kind/sessions
 *   POST /api/agent/chats/:chatId/branches/:branchId/:kind/session  { title? }
 *
 * The per-thread routes (`/api/experience-copilot/:threadId/...`) stay
 * owner-agnostic, so only these three lifecycle members are chat-specific —
 * the future chat-only host (SC-13) composes them with the shared per-thread
 * fns behind its transport. Unknown kind → 400 `UNKNOWN_AGENT_KIND`, a
 * non-chat-owned kind → 400 `AGENT_KIND_NOT_CHAT_OWNED`, missing
 * chat/branch → 404 (all surfacing through `unwrapRpc` as plain errors).
 */
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import type { AgentBranchForkSidechatResult, AgentBranchSidechatSummary, AgentThreadEventWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";

/** The single active thread for a (chat, branch, kind) triple, or null when none exists. */
export async function getAgentChatActive(
  chatId: string,
  branchId: string,
  agentKind: string,
): Promise<ExperienceCopilotThreadWire | null> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"][":kind"].active.$get({
    param: { chatId, branchId, kind: agentKind },
  });
  return unwrapRpc(response);
}

/** All sessions (active + archived) for a (chat, branch, kind) triple, newest first. */
export async function listAgentChatSessions(
  chatId: string,
  branchId: string,
  agentKind: string,
): Promise<ExperienceCopilotThreadWire[]> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"][":kind"].sessions.$get({
    param: { chatId, branchId, kind: agentKind },
  });
  return unwrapRpc(response);
}

/** All frozen context events for a thread, in merged-timeline order (SC-19b) —
 *  the sidechat host's transport member behind `AgentHostTransport.listEvents`:
 *  each `{ id, kind, payload, beforeMessageId }` the events route serves,
 *  rendered by the shell as timeline separators around the message feed. */
export async function listAgentThreadEvents(
  threadId: string,
): Promise<AgentThreadEventWire[]> {
  const response = await client.api.agent.threads[":threadId"].events.$get({
    param: { threadId },
  });
  return unwrapRpc(response);
}

/** Archive the current active thread (if any) and start a fresh one for the triple. */
export async function startAgentChatSession(
  chatId: string,
  branchId: string,
  agentKind: string,
  title?: string,
): Promise<ExperienceCopilotThreadWire> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"][":kind"].session.$post({
    param: { chatId, branchId, kind: agentKind },
    json: title ? { title } : {},
  });
  return unwrapRpc(response);
}

/**
 * Branch-sidechat fork pair (SC-21) — the chat-owner twin of the SC-0b
 * lifecycle fns above, against the SC-20 routes:
 *
 *   GET  /api/agent/chats/:chatId/branches/:branchId/sidechat-summary
 *   POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat  { targetBranchId }
 *
 * The summary feeds the fork/delete confirms (does this branch own ACTIVE
 * chat-owned sidechat sessions?). The fork copies the source branch's
 * (`:branchId`) active threads onto the target — the target must be a CHILD
 * of the source (its `parent_branch_id`), else the typed 400
 * `target_branch_not_child_of_source` surfaces through `unwrapRpc`.
 */

/** Whether the branch owns any ACTIVE (non-archived) chat-owned sidechat sessions. */
export async function getBranchSidechatSummary(
  chatId: string,
  branchId: string,
): Promise<AgentBranchSidechatSummary> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"]["sidechat-summary"].$get({
    param: { chatId, branchId },
  });
  return unwrapRpc(response);
}

/** Copy the source branch's active sidechat threads onto the target branch (its child). */
export async function forkBranchSidechat(
  chatId: string,
  sourceBranchId: string,
  targetBranchId: string,
): Promise<AgentBranchForkSidechatResult> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"]["fork-sidechat"].$post({
    param: { chatId, branchId: sourceBranchId },
    json: { targetBranchId },
  });
  return unwrapRpc(response);
}
