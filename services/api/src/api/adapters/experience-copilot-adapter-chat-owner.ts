// Chat-owner agent-session lifecycle (SIDECHAT_PLAN SC-0b) — the three
// chat/branch/kind lifecycle members of ExperienceCopilotAdapter
// (getActive / listSessions / startNewSession), extracted verbatim (code
// and comments moved, not rewritten) when DR-12's pending-separator
// materialization pushed the adapter past the arch-gate size cap — the
// ratchet's remedy is extraction, never trimming; same precedent as
// experience-copilot-attachment-actions.ts. The adapter keeps thin
// delegating members so the runtime contract and its callers are unchanged.
import type { StoreContainer, ChatAgentSettingsStore, ExperienceCopilotStore } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import type { AgentKindId } from "../../domain/agent/agent-kind.js";
import {
  getChatOwnedAgentKind,
  kindServesChatMode,
  requireKindServesChatMode,
} from "../../domain/agent/agent-kind-registry.js";
import { requireChatBranch } from "../../domain/chat/chat-branch-ownership.js";
import { materializePendingSidechatProfileChange } from "../../domain/sidechat/sidechat-profile-change.js";
import { toThreadWire } from "./experience-copilot-wire-mappers.js";

/** The adapter's collaborators the lifecycle needs. `kindAutoCompactDefault`
 *  stays an adapter method (it reads the kind-settings store through the
 *  adapter's own resolution seam) and rides in as a callback — the
 *  attachment-actions factory pattern. */
export interface ChatOwnerLifecycleDeps {
  experienceCopilot: ExperienceCopilotStore;
  chatAgentSettings: ChatAgentSettingsStore;
  chats: StoreContainer["chats"];
  kindAutoCompactDefault: (kindId: AgentKindId) => Promise<boolean>;
}

export function createChatOwnerLifecycle(deps: ChatOwnerLifecycleDeps) {
  return {
    getActive: async (
      chatId: string,
      branchId: string,
      kind: string,
    ): Promise<ExperienceCopilotThreadWire | null> => {
      const agentKind = getChatOwnedAgentKind(kind);
      const { chat } = await requireChatBranch(deps.chats, chatId, branchId);
      // SC-7b: a chat whose mode the kind does not serve READS empty — the
      // active twin of the sessions list's empty array, so a chat whose mode
      // changed after its sessions were born never shows an active session
      // its own list omits (the rows stay; the mode may change back).
      if (!kindServesChatMode(agentKind, chat.mode)) return null;
      const thread = await deps.experienceCopilot.getActiveForChat(chatId, branchId, kind);
      return thread ? toThreadWire(thread) : null;
    },

    listSessions: async (
      chatId: string,
      branchId: string,
      kind: string,
    ): Promise<ExperienceCopilotThreadWire[]> => {
      const agentKind = getChatOwnedAgentKind(kind);
      const { chat } = await requireChatBranch(deps.chats, chatId, branchId);
      // SC-7b: listing on a chat whose mode the kind does not serve answers
      // EMPTY, not an error — reads never 400 on the mode (only the create
      // path does; see startNewSession).
      if (!kindServesChatMode(agentKind, chat.mode)) return [];
      const threads = await deps.experienceCopilot.listSessionsForChat(chatId, branchId, kind);
      return threads.map((t) => toThreadWire(t));
    },

    startNewSession: async (
      chatId: string,
      branchId: string,
      kind: string,
      title?: string,
    ): Promise<ExperienceCopilotThreadWire> => {
      const agentKind = getChatOwnedAgentKind(kind);
      const { chat } = await requireChatBranch(deps.chats, chatId, branchId);
      // SC-7b: a chat-owned session is born only on a mode the kind serves —
      // the registry's typed error, mapped by the route to the shared 400
      // `{ error, code }` shape naming the kind and the mode. Runs before the
      // store write, so a refused create leaves no row behind.
      requireKindServesChatMode(agentKind, chat.mode);
      // AP-20: the new thread's auto_compact seeds from this kind's default —
      // the per-thread toggle is authoritative from here on.
      const autoCompact = await deps.kindAutoCompactDefault(agentKind.id);
      const thread = await deps.experienceCopilot.startNewChatSession(chatId, branchId, kind, title, autoCompact);
      // DR-12: a profile switch that happened while the pair had no active
      // thread parks its separator on the settings row — the first session
      // born after it lands the event at the feed's top (the module's own
      // best-effort logging; never fails the create).
      await materializePendingSidechatProfileChange(
        { experienceCopilot: deps.experienceCopilot, chatAgentSettings: deps.chatAgentSettings },
        { chatId, agentKind: kind, threadId: thread.id },
      );
      return toThreadWire(thread);
    },
  };
}

export type ChatOwnerLifecycle = ReturnType<typeof createChatOwnerLifecycle>;
