/**
 * agent-host-registry — register/get/unsubscribe/duplicate/re-register.
 */
import { describe, expect, it } from "bun:test";
import {
  AgentHostAlreadyRegisteredError,
  UnknownAgentHostError,
  getAgentHost,
  registerAgentHost,
  type AgentHostDescriptor,
} from "./agent-host-registry.js";

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
    bufferSpecs: [],
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
