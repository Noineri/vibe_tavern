import { create } from "zustand";
import {
  getAgentChatSettings,
  patchAgentChatSettings,
} from "../api/agent-chat-settings-api.js";
import { SIDECHAT_AGENT_KIND } from "../api/agent-kind-served-modes.js";
import { useBootstrapStore } from "./api-actions/bootstrap-actions.js";
import { useCopilotProfileStore } from "./copilot-profile-store.js";
import { useSidechatMobileStore } from "./sidechat-mobile-store.js";
import { useSidechatOpenStore } from "./sidechat-open-store.js";
import {
  BUILTIN_DIRECTOR_PROFILE_ID,
  resolveChatEffectiveProfileId,
} from "../lib/agent-builtin-profiles.js";
import { agentOwnerKey } from "../lib/agent-host-registry.js";

/**
 * The director-call action (DIRECTOR_MODE_PLAN DR-12 — the strip button key
 * `story_plan_call_director`) — the one sidechat CALL
 * action behind the story strip's button, and
 * the pending-send bridge the sidechat shell consumes.
 *
 * What one call does, in order (mock §4):
 * 1. resolves the chat's EFFECTIVE sidechat profile through the existing
 *    seams — the (chat, kind) row (`getAgentChatSettings`), the bootstrap
 *    kind default, the shared profile list, and the ONE SC-0k chain
 *    (`resolveChatEffectiveProfileId`) — and, when that profile does not
 *    carry the `propose_plan` tool, assigns `builtin-director` through the
 *    DR-6 write path (`patchAgentChatSettings` — the same client call
 *    `useAgentProfileAssignment.assignHere` makes; the server appends the
 *    `profile_changed` separator uniformly for every switch surface).
 * 2. opens the sidechat surface: the ONE open flag (SC-18a) on desktop and
 *    the sidechat tab (SC-15) on mobile.
 * 3. queues the call's message (the i18n key `story_plan_call_director_message`,
 *    resolved by the SHELL at send time so it follows the live language):
 *    the entry is keyed by the sidechat owner key (chat+branch+kind), so a
 *    repeat call while an entry is pending is a no-op, and the shell's
 *    consume is remove-first — a double click sends exactly ONE message.
 *
 * Ordering: the profile write runs BEFORE the open, so the shell (and its
 * profile chip) mount against the already-switched row — no stale label
 * frame. A failed switch still opens and queues (the message also works
 * under the current profile — `read_plan` is on everywhere) and the failure
 * is rethrown for the caller's toast (the assignment-failure key).
 *
 * Plain zustand store (UI state, not canonical data — the queue is
 * ephemeral; the sent message is the durable outcome).
 */
interface SidechatCallDirectorState {
  /** Pending calls keyed by sidechat owner key — presence means "the shell
   *  owes this owner one director call message". */
  pending: Record<string, boolean>;
  /** Queue an owner's call (a no-op while one is already pending — the
   *  exactly-once guard's first half; the second half is `consume`). */
  enqueue: (ownerKey: string) => void;
  /** Remove-first consume: true only for the caller that took the entry —
   *  the exactly-once law under double-fire effects (StrictMode, rerender
   *  races): only ONE consume call ever returns true per entry. */
  consume: (ownerKey: string) => boolean;
}

export const useSidechatCallDirectorStore = create<SidechatCallDirectorState>((set, get) => ({
  pending: {},
  enqueue: (ownerKey) => {
    if (get().pending[ownerKey]) return;
    set((s) => ({ pending: { ...s.pending, [ownerKey]: true } }));
  },
  consume: (ownerKey) => {
    if (!get().pending[ownerKey]) return false;
    set((s) => {
      const next = { ...s.pending };
      delete next[ownerKey];
      return { pending: next };
    });
    return true;
  },
}));

/** The sidechat owner key for a (chat, branch) pair — the SAME spelling the
 *  shell and the streaming mirror use (`agentOwnerKey`), so the queue and
 *  the shell's consumption line up. */
export function sidechatCallKey(chatId: string, branchId: string): string {
  return agentOwnerKey({ kind: "chat", chatId, branchId, agentKind: SIDECHAT_AGENT_KIND });
}

/**
 * The director-call action (DR-12). See the module doc for the order
 * and the failure policy; rejects with the underlying error ONLY after the
 * open + queue have happened, so a failed switch never eats the click.
 */
export async function callDirector(chatId: string, branchId: string): Promise<void> {
  let failure: unknown = null;
  try {
    // 1) the effective profile through the existing seams — fresh (chat,
    // kind) read (a parked choice elsewhere may have moved it), the shared
    // profile list (loaded for the sidechat kind when the chip never did),
    // the bootstrap kind default, and the ONE SC-0k chain.
    const settings = await getAgentChatSettings(chatId, SIDECHAT_AGENT_KIND);
    const profileStore = useCopilotProfileStore.getState();
    let profiles = profileStore.profiles;
    if (!profileStore.hasLoaded || profileStore.kind !== SIDECHAT_AGENT_KIND) {
      await useCopilotProfileStore.getState().load(SIDECHAT_AGENT_KIND);
      profiles = useCopilotProfileStore.getState().profiles;
    }
    const kindDefault =
      useBootstrapStore.getState().data?.agentKindSettings?.[SIDECHAT_AGENT_KIND]?.defaultProfileId ?? null;
    const effectiveId = resolveChatEffectiveProfileId(
      settings.profileId,
      kindDefault,
      new Set(profiles.map((profile) => profile.id)),
    );
    const effective = profiles.find((profile) => profile.id === effectiveId);
    // The wire profile's toolSet is the per-kind union — read the one key we
    // need through the record shape (the profile modal's own read pattern).
    const toolSet: Record<string, boolean | undefined> = effective?.toolSet ?? {};
    // 2) switch ONLY when the active profile lacks the plan tool (A10's
    // precondition) — a director-capable profile (own copy or the built-in
    // director itself) stays; the write is the DR-6 (chat, kind) row write.
    if (toolSet.propose_plan !== true) {
      await patchAgentChatSettings(chatId, SIDECHAT_AGENT_KIND, {
        profileId: BUILTIN_DIRECTOR_PROFILE_ID,
      });
    }
  } catch (err) {
    failure = err;
  }
  // 3) open the surface + queue the message — ALWAYS (see the module doc).
  useSidechatOpenStore.getState().setOpen(chatId, true);
  useSidechatMobileStore.getState().setTab("sidechat");
  useSidechatCallDirectorStore.getState().enqueue(sidechatCallKey(chatId, branchId));
  if (failure !== null) throw failure;
}

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores (diagnosing "the call message never sent" reports).
if (typeof window !== "undefined") {
  (window as unknown as { __useSidechatCallDirectorStore?: unknown }).__useSidechatCallDirectorStore =
    useSidechatCallDirectorStore;
}
