/**
 * sidechat-call-director-store (DIRECTOR_MODE_PLAN DR-12) — the
 * «Позвать режиссёра» action's contract:
 *
 *   - opens the surface: the ONE open flag's per-chat entry (SC-18a) and the
 *     mobile «Сайдчат» tab (SC-15);
 *   - switches the (chat, kind) row to `builtin-director` ONLY when the
 *     ACTIVE profile lacks `propose_plan` — the OOC seed switches, the
 *     director built-in and an own director-capable profile do NOT (the
 *     write is the DR-6 assignHere path's client call, pinned by args);
 *   - a failed switch still opens + queues and rethrows (the caller toasts);
 *   - the queue is keyed by the sidechat owner key: a repeat call while an
 *     entry is pending is a no-op, and `consume` is remove-first — the
 *     exactly-once law under double-fire effects (a double click sends ONE
 *     message).
 *
 * Runner: bun:test, no DOM (a plain store suite). The api clients are
 * mocked at the module seam (`...real` spread, the chip test's pattern);
 * the profile/bootstrap stores are seeded directly (they ARE the seams the
 * action reads). `localStorage` is absent under bun — the open store's
 * guarded write keeps the in-memory entry authoritative here.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";

const realChatSettingsApi = await import("../api/agent-chat-settings-api.js");

const getAgentChatSettings = mock(async (_chatId: string, _kind: string) => ({
  chatId: _chatId,
  agentKind: _kind,
  profileId: null as string | null,
  updatedAt: null as string | null,
}));
const patchAgentChatSettings = mock(
  async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
    chatId: _chatId,
    agentKind: _kind,
    profileId: _patch.profileId ?? null,
    updatedAt: "",
  }),
);
mock.module("../api/agent-chat-settings-api.js", () => ({
  ...realChatSettingsApi,
  getAgentChatSettings,
  patchAgentChatSettings,
}));

const { useSidechatCallDirectorStore, callDirector, sidechatCallKey } = await import(
  "./sidechat-call-director-store.js"
);
const { useSidechatOpenStore } = await import("./sidechat-open-store.js");
const { useSidechatMobileStore } = await import("./sidechat-mobile-store.js");
const { useCopilotProfileStore } = await import("./copilot-profile-store.js");
const { useBootstrapStore } = await import("./api-actions/bootstrap-actions.js");
const { SIDECHAT_AGENT_KIND } = await import("../api/agent-kind-served-modes.js");
const { CHAT_MODE } = await import("@vibe-tavern/domain");
const { wireUiSettings } = await import("../../test/wire-fixtures.js");
import type { BootstrapData } from "./api-actions/bootstrap-actions.js";

const CHAT_ID = "d12-chat";
const BRANCH_ID = "d12-branch";
/** The sidechat owner key — the SAME `agentOwnerKey` spelling the shell's
 *  consumption effect reads. */
const OWNER_KEY = `chat:${CHAT_ID}:${BRANCH_ID}:${SIDECHAT_AGENT_KIND}`;

/** The kind's first seed (the OOC built-in — no `propose_plan`). */
const SEED: CopilotProfile = {
  id: "builtin",
  name: "Out of character",
  isBuiltIn: true,
  basePrompt: "You chat out of character.",
  toolSet: {},
  agentKind: SIDECHAT_AGENT_KIND,
};
/** The director built-in (carries the plan tool). */
const DIRECTOR: CopilotProfile = {
  id: "builtin-director",
  name: "Director",
  isBuiltIn: true,
  basePrompt: "You direct the story.",
  toolSet: { propose_plan: true },
  agentKind: SIDECHAT_AGENT_KIND,
};
/** An own profile WITH the plan tool — no switch either. */
const OWN_DIRECTOR: CopilotProfile = {
  id: "cprof_mine",
  name: "My grim director",
  isBuiltIn: false,
  basePrompt: "You direct, grimly.",
  toolSet: { propose_plan: true },
  agentKind: SIDECHAT_AGENT_KIND,
};
/** An own profile WITHOUT the plan tool — switches. */
const OWN_PLAIN: CopilotProfile = {
  id: "cprof_plain",
  name: "My plain sidechat",
  isBuiltIn: false,
  basePrompt: "You chat.",
  toolSet: {},
  agentKind: SIDECHAT_AGENT_KIND,
};

function seedProfiles(profiles: readonly CopilotProfile[]): void {
  useCopilotProfileStore.setState({
    profiles: [...profiles],
    isLoading: false,
    hasLoaded: true,
    kind: SIDECHAT_AGENT_KIND,
  });
}

/** One kind-settings entry with a kind default (the bootstrap fact the
 *  SC-0k chain reads) — the sibling modal suites' full-`BootstrapData`
 *  seeding pattern (the store's `data` field is all-or-nothing). */
function bootstrapDataWithKindDefault(defaultProfileId: string | null): BootstrapData {
  return {
    initialChatId: null,
    snapshot: null,
    isFirstRun: false,
    allCharacters: [],
    promptPresets: [],
    uiSettings: wireUiSettings(),
    agentKindSettings: {
      [SIDECHAT_AGENT_KIND]: {
        agentKind: SIDECHAT_AGENT_KIND,
        providerProfileId: null,
        modelName: null,
        defaultProfileId,
        updatedAt: null,
        servesChatModes: [CHAT_MODE.rp],
        autoCompactDefault: true,
      },
    },
    isArmServer: false,
  };
}

function resetStores(): void {
  useSidechatCallDirectorStore.setState({ pending: {} });
  useSidechatOpenStore.setState({ openByChat: {} });
  useSidechatMobileStore.getState().setTab("chat");
  useBootstrapStore.setState({ data: null });
  getAgentChatSettings.mockReset();
  getAgentChatSettings.mockResolvedValue({ chatId: CHAT_ID, agentKind: SIDECHAT_AGENT_KIND, profileId: null, updatedAt: null });
  patchAgentChatSettings.mockReset();
  patchAgentChatSettings.mockResolvedValue({ chatId: CHAT_ID, agentKind: SIDECHAT_AGENT_KIND, profileId: null, updatedAt: "" });
}

beforeEach(() => {
  resetStores();
  seedProfiles([SEED, DIRECTOR, OWN_DIRECTOR, OWN_PLAIN]);
});

afterEach(() => {
  resetStores();
});

describe("callDirector (DR-12)", () => {
  test("opens the surface: the open flag's chat entry + the mobile sidechat tab", async () => {
    await callDirector(CHAT_ID, BRANCH_ID);
    expect(useSidechatOpenStore.getState().openByChat[CHAT_ID]).toBe(true);
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
  });

  test("switches to builtin-director through the (chat, kind) row when the active profile lacks the plan tool", async () => {
    // No chat choice, no kind default → the seed is effective.
    await callDirector(CHAT_ID, BRANCH_ID);
    expect(patchAgentChatSettings).toHaveBeenCalledTimes(1);
    expect(patchAgentChatSettings.mock.calls[0]!.slice(0, 3)).toEqual([
      CHAT_ID,
      SIDECHAT_AGENT_KIND,
      { profileId: "builtin-director" },
    ]);
  });

  test("an own profile without the plan tool switches too — the kind default resolves it", async () => {
    useBootstrapStore.setState({ data: bootstrapDataWithKindDefault(OWN_PLAIN.id) });
    await callDirector(CHAT_ID, BRANCH_ID);
    expect(patchAgentChatSettings).toHaveBeenCalledTimes(1);
  });

  test("NO switch when the active profile carries propose_plan (the director built-in)", async () => {
    getAgentChatSettings.mockResolvedValue({
      chatId: CHAT_ID,
      agentKind: SIDECHAT_AGENT_KIND,
      profileId: "builtin-director",
      updatedAt: "",
    });
    await callDirector(CHAT_ID, BRANCH_ID);
    expect(patchAgentChatSettings).not.toHaveBeenCalled();
  });

  test("NO switch when the active profile is an own copy with propose_plan", async () => {
    getAgentChatSettings.mockResolvedValue({
      chatId: CHAT_ID,
      agentKind: SIDECHAT_AGENT_KIND,
      profileId: OWN_DIRECTOR.id,
      updatedAt: "",
    });
    await callDirector(CHAT_ID, BRANCH_ID);
    expect(patchAgentChatSettings).not.toHaveBeenCalled();
  });

  test("a failed switch still opens + queues, and rethrows for the caller's toast", async () => {
    patchAgentChatSettings.mockRejectedValue(new Error("network down"));
    await expect(callDirector(CHAT_ID, BRANCH_ID)).rejects.toThrow("network down");
    // The click's purpose survived the failed switch: the surface opened
    // and the message is queued (it also works under the current profile).
    expect(useSidechatOpenStore.getState().openByChat[CHAT_ID]).toBe(true);
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
    expect(useSidechatCallDirectorStore.getState().pending[OWNER_KEY]).toBe(true);
  });

  test("queues exactly-once: a repeat call while pending is a no-op, consume is remove-first", async () => {
    // A double click: two calls back to back.
    const first = callDirector(CHAT_ID, BRANCH_ID);
    const second = callDirector(CHAT_ID, BRANCH_ID);
    await Promise.all([first, second]);
    // ONE queue entry (the key matches the shell's owner-key spelling).
    expect(Object.keys(useSidechatCallDirectorStore.getState().pending)).toEqual([OWNER_KEY]);
    expect(sidechatCallKey(CHAT_ID, BRANCH_ID)).toBe(OWNER_KEY);
    // Remove-first: only the first consume takes it — a double-fire effect
    // sends ONE message.
    expect(useSidechatCallDirectorStore.getState().consume(OWNER_KEY)).toBe(true);
    expect(useSidechatCallDirectorStore.getState().consume(OWNER_KEY)).toBe(false);
    expect(useSidechatCallDirectorStore.getState().pending[OWNER_KEY]).toBeUndefined();
  });
});
