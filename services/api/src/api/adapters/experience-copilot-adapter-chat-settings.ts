// Per-(chat, agent-kind) profile-choice members (SIDECHAT_PLAN SC-0f + DR-12)
// — the (chat, kind) settings pair (get / patch) of ExperienceCopilotAdapter,
// extracted verbatim (code and comments moved, not rewritten) when DR-12's
// profile-switch separator wiring pushed the adapter past the arch-gate size
// cap — the ratchet's remedy is extraction, never trimming; same precedent as
// experience-copilot-adapter-chat-owner.ts. The adapter keeps thin delegating
// members so the runtime contract and its callers are unchanged.
import type { ChatAgentSettingsStore, StoreContainer } from "@vibe-tavern/db";
import type { AgentChatSettingsPatchRequest, AgentChatSettingsWire } from "@vibe-tavern/api-contracts";
import { getChatOwnedAgentKind } from "../../domain/agent/agent-kind-registry.js";
import type { CopilotProfileResolver } from "../../domain/interactive/copilot/copilot-profile-resolver.js";
import { recordSidechatProfileChange } from "../../domain/sidechat/sidechat-profile-change.js";
import { notFound } from "../../shared/errors.js";
import { toChatSettingsWire } from "./experience-copilot-wire-mappers.js";

/** The adapter's collaborators the settings pair needs. */
export interface ChatSettingsPairDeps {
  chats: StoreContainer["chats"];
  chatAgentSettings: ChatAgentSettingsStore;
  experienceCopilot: StoreContainer["experienceCopilot"];
  profileResolver: CopilotProfileResolver;
}

export function createChatSettingsPair(deps: ChatSettingsPairDeps) {
  /** The chat path segment of the SC-0f chat-settings routes: the chat must
   *  exist (404) — these routes carry no branch segment, so there is no
   *  branch-ownership check to pair with (unlike the shared requireChatBranch
   *  pair check in domain/chat/chat-branch-ownership). */
  async function requireChat(chatId: string): Promise<void> {
    const chat = await deps.chats.getById(chatId);
    if (!chat) {
      throw notFound("Chat", `Chat '${chatId}' was not found.`);
    }
  }

  return {
    getSettings: async (
      chatId: string,
      kind: string,
    ): Promise<AgentChatSettingsWire> => {
      // The SC-0b validation order: the kind is chat-owner-validated FIRST
      // (400 class, no store I/O — a script-owned kind on a chat route is the
      // 400 AGENT_KIND_NOT_CHAT_OWNED), then the chat's existence (404).
      getChatOwnedAgentKind(kind);
      await requireChat(chatId);
      return toChatSettingsWire(await deps.chatAgentSettings.get(chatId, kind));
    },

    patchSettings: async (
      chatId: string,
      kind: string,
      body: AgentChatSettingsPatchRequest,
    ): Promise<AgentChatSettingsWire> => {
      getChatOwnedAgentKind(kind);
      await requireChat(chatId);
      // DR-12: the effective profile BEFORE the write — the separator fires
      // only on a real effective change (from ≠ to), so a patch that re-pins
      // the current effective profile (or leaves it untouched) records
      // nothing. Resolved only when the patch can move the chain at all.
      let before: Awaited<ReturnType<CopilotProfileResolver["resolveForChat"]>> | null = null;
      if (body.profileId !== undefined) {
        before = await deps.profileResolver.resolveForChat(chatId, kind);
      }
      const updated = await deps.chatAgentSettings.patch(chatId, kind, body);
      if (before !== null) {
        const after = await deps.profileResolver.resolveForChat(chatId, kind);
        if (after.id !== before.id) {
          // Server-side uniformity: EVERY switch surface (chip menu, settings
          // dropdown, the DR-7 hand-off row, callDirector) rides this PATCH,
          // so every switch produces the same separator. Best-effort inside.
          await recordSidechatProfileChange(
            { experienceCopilot: deps.experienceCopilot, chatAgentSettings: deps.chatAgentSettings },
            { chatId, agentKind: kind, from: before, to: after },
          );
        }
      }
      return toChatSettingsWire(updated);
    },
  };
}

export type ChatSettingsPair = ReturnType<typeof createChatSettingsPair>;
