/**
 * agent-host-registry — register/get/unsubscribe/duplicate/re-register.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
  AgentHostAlreadyRegisteredError,
  UnknownAgentHostError,
  chatOwnerTriple,
  getAgentHost,
  registerAgentHost,
  scriptOwnerId,
  type AgentHostDescriptor,
} from "./agent-host-registry.js";
import {
  activateExperienceCopilotSession,
  answerCopilotAsk,
  deleteCopilotTurn,
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  listExperienceCopilotSessions,
  renameExperienceCopilotSession,
  setExperienceCopilotContextLinks,
  startExperienceCopilotSession,
  streamExperienceCopilot,
} from "../api/experience-copilot-api.js";

function descriptor(kind: string): AgentHostDescriptor {
  return {
    kind,
    i18n: {
      // AS-6b2: the descriptor's i18n fields are the strict generated-key
      // union, so synthetic `${kind}.*` strings no longer typecheck — the
      // registry treats the keys as opaque tokens either way; real keys keep
      // the fixture honest against the locale source.
      title: "agent_title",
      kindLabel: "agent_kind_script",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
      emptySub: "agent_subtitle",
    },
    // AP-17: required on every descriptor (exactly four keys — the tuple
    // type makes a wrong count a compile break); the fixture reuses the
    // script host's four real keys to stay honest against the locale source.
    starterPromptKeys: [
      "agent_starter_script_explain",
      "agent_starter_script_fix_bugs",
      "agent_starter_script_comment",
      "agent_starter_script_simplify",
    ],
    toolKeys: [],
    // SC-0g: the registry-mechanics fixture is script-owned (the field is
    // required on every descriptor; the chat target is pinned by the modal's
    // own fixture in AgentProfileModal.test.tsx).
    profileAssignment: { target: "script" },
    // AP-2: required on every descriptor (a missing markup is a compile
    // break); the per-host VALUES are pinned by the host tests + the
    // list's pass-through test.
    messageMarkup: "plain",
    bufferSpecs: [],
    // AS-6c-i: the transport seam — fixture data mirrors the experience
    // host's delegation to the real client fns (registry-mechanics tests never
    // CALL these; real signatures keep the fixture honest against the seam's
    // typeof-mirrored member types).
    transport: {
      sendStream: streamExperienceCopilot,
      answerAsk: answerCopilotAsk,
      // AP-10: required on every transport (a missing deleteTurn is a
      // compile break).
      deleteTurn: deleteCopilotTurn,
      // SC-0c repair (assertions unchanged): the seam takes the typed
      // owner now — the fixture maps it back exactly as the hosts do.
      getActiveThread: (owner) => getExperienceCopilotActive(scriptOwnerId(owner)),
      listMessages: listExperienceCopilotMessages,
      startSession: (owner, title?) => startExperienceCopilotSession(scriptOwnerId(owner), title),
      listSessions: (owner) => listExperienceCopilotSessions(scriptOwnerId(owner)),
      activateSession: activateExperienceCopilotSession,
      renameSession: renameExperienceCopilotSession,
      setContextLinks: setExperienceCopilotContextLinks,
    },
    buildSendOptions: () => ({}),
    recordProposalRenderers: {},
  };
}

describe("agent-host-registry", () => {
  it("register → getter returns the same object", () => {
    const host = descriptor("as5-getter");
    const unsubscribe = registerAgentHost(host);
    try {
      expect(getAgentHost("as5-getter")).toBe(host);
    } finally {
      unsubscribe();
    }
  });

  it("a registered host exposes its toolKeys", () => {
    const toolKeys = ["write_buffer", "plan"] as const;
    const host: AgentHostDescriptor = { ...descriptor("as8b-tool-keys"), toolKeys };
    const unsubscribe = registerAgentHost(host);
    try {
      expect(getAgentHost("as8b-tool-keys").toolKeys).toEqual(["write_buffer", "plan"]);
    } finally {
      unsubscribe();
    }
  });

  it("unsubscribe stops returning (getter throws)", () => {
    const unsubscribe = registerAgentHost(descriptor("as5-unsub"));
    unsubscribe();
    expect(() => getAgentHost("as5-unsub")).toThrow(UnknownAgentHostError);
  });

  it("duplicate kind throws", () => {
    const unsubscribe = registerAgentHost(descriptor("as5-dup"));
    try {
      expect(() => registerAgentHost(descriptor("as5-dup"))).toThrow(AgentHostAlreadyRegisteredError);
    } finally {
      unsubscribe();
    }
  });

  it("defaultModelBinding is absent unless the host defines it (SC-0e)", () => {
    const unsubscribe = registerAgentHost(descriptor("sc0e-no-hook"));
    try {
      expect(getAgentHost("sc0e-no-hook").defaultModelBinding).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("a host-provided defaultModelBinding is returned through the descriptor", () => {
    const host: AgentHostDescriptor = {
      ...descriptor("sc0e-hook"),
      defaultModelBinding: () => ({ providerProfileId: "p1", modelName: "m1" }),
    };
    const unsubscribe = registerAgentHost(host);
    try {
      const binding = getAgentHost("sc0e-hook").defaultModelBinding?.({
        owner: { kind: "script", scriptId: "s-1" },
        profiles: [],
      });
      expect(binding).toEqual({ providerProfileId: "p1", modelName: "m1" });
    } finally {
      unsubscribe();
    }
  });

  it("planOwner is absent unless the host defines it (SC-0i)", () => {
    const unsubscribe = registerAgentHost(descriptor("sc0i-no-hook"));
    try {
      expect(getAgentHost("sc0i-no-hook").planOwner).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("a host-provided planOwner derives the script owner from the shell context (SC-0i)", () => {
    const host: AgentHostDescriptor = {
      ...descriptor("sc0i-hook"),
      planOwner: (ctx) => {
        if (ctx.owner.kind !== "script") return undefined;
        return { kind: "script", scriptId: ctx.owner.scriptId };
      },
    };
    const unsubscribe = registerAgentHost(host);
    try {
      expect(getAgentHost("sc0i-hook").planOwner?.({ owner: { kind: "script", scriptId: "s-1" } })).toEqual({
        kind: "script",
        scriptId: "s-1",
      });
    } finally {
      unsubscribe();
    }
  });

  it("profileAssignment round-trips through the descriptor (SC-0g)", () => {
    const scriptHost: AgentHostDescriptor = { ...descriptor("sc0g-script"), profileAssignment: { target: "script" } };
    const chatHost: AgentHostDescriptor = { ...descriptor("sc0g-chat"), profileAssignment: { target: "chat" } };
    const unsubScript = registerAgentHost(scriptHost);
    const unsubChat = registerAgentHost(chatHost);
    try {
      expect(getAgentHost("sc0g-script").profileAssignment).toEqual({ target: "script" });
      expect(getAgentHost("sc0g-chat").profileAssignment).toEqual({ target: "chat" });
    } finally {
      unsubScript();
      unsubChat();
    }
  });

  it("chatOwnerTriple narrows a chat owner and throws on a script owner (SC-13b)", () => {
    expect(
      chatOwnerTriple({ kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: "sidechat-ooc" }),
    ).toEqual({ chatId: "chat-1", branchId: "branch-1", agentKind: "sidechat-ooc" });
    expect(() => chatOwnerTriple({ kind: "script", scriptId: "s-1" })).toThrow();
  });

  it("re-register after unsubscribe works (stale unsubscribe is a no-op)", () => {
    const first = descriptor("as5-rereg");
    const unsubscribeFirst = registerAgentHost(first);
    unsubscribeFirst();
    const second = descriptor("as5-rereg");
    const unsubscribeSecond = registerAgentHost(second);
    try {
      expect(getAgentHost("as5-rereg")).toBe(second);
      // The stale kill guard: the FIRST unsubscribe must not remove the
      // second registration under the same kind.
      unsubscribeFirst();
      expect(getAgentHost("as5-rereg")).toBe(second);
    } finally {
      unsubscribeSecond();
    }
  });
});

// ── AP-17: the built-in hosts' starter prompts + kind labels ───────────────
// The registry-mechanics tests above use synthetic fixtures; these pins read
// the THREE real host modules (module-load registration — the AgentChatPane
// test's dynamic-import precedent) so the per-host VALUES are pinned in one
// cross-host place (the experience host has no test file of its own). The
// KEY STRINGS, not the translated copy, are the contract here — the mockup
// verbatim RU values live in `i18n/locales/ru.json` and are kept in en/ru
// parity by the i18n gate.
describe("agent-host-registry — built-in hosts (AP-17)", () => {
  const KINDS = ["experience", "script", "sidechat-ooc"] as const;

  beforeAll(async () => {
    await import("../components/build/editors/copilot/experience-agent-host.js");
    await import("../components/build/editors/script-agent-host.js");
    await import("../components/chat/sidechat/sidechat-host.js");
  });

  it("every built-in host carries a kindLabel and exactly four starter prompt keys", () => {
    for (const kind of KINDS) {
      const host = getAgentHost(kind);
      expect(typeof host.i18n.kindLabel).toBe("string");
      expect(host.starterPromptKeys).toHaveLength(4);
    }
  });

  it("pins each built-in host's kindLabel key", () => {
    expect(getAgentHost("experience").i18n.kindLabel).toBe("agent_kind_experience");
    expect(getAgentHost("script").i18n.kindLabel).toBe("agent_kind_script");
    expect(getAgentHost("sidechat-ooc").i18n.kindLabel).toBe("agent_kind_sidechat");
  });

  it("pins each built-in host's four starter prompt keys in mockup order", () => {
    expect(getAgentHost("experience").starterPromptKeys).toEqual([
      "agent_starter_experience_game",
      "agent_starter_experience_explain_rules",
      "agent_starter_experience_find_bugs",
      "agent_starter_experience_polish_visual",
    ]);
    expect(getAgentHost("script").starterPromptKeys).toEqual([
      "agent_starter_script_explain",
      "agent_starter_script_fix_bugs",
      "agent_starter_script_comment",
      "agent_starter_script_simplify",
    ]);
    expect(getAgentHost("sidechat-ooc").starterPromptKeys).toEqual([
      "agent_starter_sidechat_recap",
      "agent_starter_sidechat_feelings",
      "agent_starter_sidechat_twists",
      "agent_starter_sidechat_pacing",
    ]);
  });
});
