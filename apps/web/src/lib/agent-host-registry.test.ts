/**
 * agent-host-registry — register/get/unsubscribe/duplicate/re-register.
 */
import { describe, expect, it } from "bun:test";
import {
  AgentHostAlreadyRegisteredError,
  UnknownAgentHostError,
  getAgentHost,
  registerAgentHost,
  scriptOwnerId,
  type AgentHostDescriptor,
} from "./agent-host-registry.js";
import {
  activateExperienceCopilotSession,
  answerCopilotAsk,
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
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
      emptySub: "agent_subtitle",
    },
    toolKeys: [],
    // SC-0g: the registry-mechanics fixture is script-owned (the field is
    // required on every descriptor; the chat target is pinned by the modal's
    // own fixture in AgentProfileModal.test.tsx).
    profileAssignment: { target: "script" },
    bufferSpecs: [],
    // AS-6c-i: the transport seam — fixture data mirrors the experience
    // host's delegation to the real client fns (registry-mechanics tests never
    // CALL these; real signatures keep the fixture honest against the seam's
    // typeof-mirrored member types).
    transport: {
      sendStream: streamExperienceCopilot,
      answerAsk: answerCopilotAsk,
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
