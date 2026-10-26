/**
 * The sidechat's served chat modes (SIDECHAT_PLAN SC-13b) — the ONE selector
 * over SC-7b's bootstrap fact `agentKindSettings["sidechat-ooc"].servesChatModes`
 * that SC-14 (the panel), SC-15 and SC-16 (the entries) read: a co-author chat
 * has no sidechat host, panel or entry, and nothing hard-codes the served mode.
 *
 * Lives beside the kind-settings API client (the map it reads). Pure — the
 * bootstrap store holds the map; callers subscribe to their own entry.
 */
import type { ChatMode } from "@vibe-tavern/domain";
import type { AgentKindSettingsWire } from "@vibe-tavern/api-contracts";

/** The registry slug of the sidechat kind (the server's `sidechat-ooc` kind). */
export const SIDECHAT_AGENT_KIND = "sidechat-ooc";

/**
 * The chat modes the sidechat serves — the kind's `servesChatModes` from the
 * bootstrap kind-settings map, or empty when the map (or the kind's entry)
 * has not arrived yet. Empty reads as unserved (the panel stays hidden until
 * the bootstrap lands — never a hard-coded fallback mode).
 */
export function selectSidechatServedChatModes(
  agentKindSettings: Record<string, AgentKindSettingsWire> | undefined,
): readonly ChatMode[] {
  return agentKindSettings?.[SIDECHAT_AGENT_KIND]?.servesChatModes ?? [];
}
