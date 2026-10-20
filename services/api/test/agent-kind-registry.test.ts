/**
 * Agent-kind registry (AGENT_SHELL_PLAN, Wave 1 / AS-2a).
 *
 * Pins the public registry contract: the real `experience` and `script`
 * kinds self-register at module init (experience delegating to
 * EXPERIENCE_COPILOT_MODULE, script to SCRIPT_AGENT_MODULE),
 * register/unsubscribe round-trips, duplicate-id / unknown-id /
 * unresolvable-script-kind throw their typed errors, and — the unit's real
 * test — a MINIMAL FAKE KIND registers and resolves purely through the public
 * API, proving the descriptor and mapping are data-driven, not
 * experience-bound.
 *
 * Cleanup: every fake's unsubscribe is collected and called in afterAll —
 * there is no registry reset (and none is needed).
 *
 * Order note: both built-ins register at import (side-effect imports below);
 * since AS-7 every REAL script kind (prompt/dice/interactive) is served by a
 * built-in, and first-registered-wins means a later fake can never displace
 * one — so the data-driven fake proves the mapping on a SYNTHETIC script
 * kind value no built-in serves.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { z } from "zod";
import { SCRIPT_KIND, type ScriptKind } from "@vibe-tavern/domain";
import { COPILOT_TOOL_KEYS, SCRIPT_AGENT_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import { EXPERIENCE_COPILOT_MODULE } from "../src/domain/interactive/copilot/experience-copilot-module.js";
import { SCRIPT_AGENT_MODULE } from "../src/domain/agent/script-agent/script-agent-module.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
import {
  registerAgentKind,
  getAgentKind,
  getAgentKindOf,
  resolveKindForScript,
  AgentKindAlreadyRegisteredError,
  UnknownAgentKindError,
  NoAgentKindForScriptKindError,
} from "../src/domain/agent/agent-kind-registry.js";
import type { ExperienceAgentContext } from "../src/domain/agent/kinds/experience-kind.js";
// Side-effect import: registers the real experience kind (delegation shell).
import "../src/domain/agent/kinds/experience-kind.js";
// Side-effect import: registers the real script kind (AS-7) — prompt/dice.
import "../src/domain/agent/kinds/script-kind.js";

/** A minimal fake kind — the proof the registry is experience-agnostic. */
function makeFakeKind(id: string, servesScriptKinds: readonly ScriptKind[]): AgentKind {
  return {
    id,
    owner: "script",
    servesScriptKinds,
    basePromptServiceKey: `${id}_base`,
    skillRootId: id,
    toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
    defaultToolSet: { fake_tool: true },
    recencyAnchorText: "(fake kind pins no context)",
    // Post-split fake: no legacy copilot-pair inheritance (SC-7).
    inheritsLegacyCopilotPair: false,
    renderContextPackage: () => "", // required since AS-2b; fakes don't render
  };
}

const unsubscribes: Array<() => void> = [];
afterAll(() => {
  for (const off of unsubscribes) off();
});

describe("agent-kind registry (AS-2a)", () => {
  test("registerAgentKind returns an unsubscribe; getAgentKind round-trips and throws UnknownAgentKindError after it", () => {
    const fake = makeFakeKind("fake-roundtrip", []);
    const off = registerAgentKind(fake);
    // Safety net if the test fails before its own unsubscribe; idempotent.
    unsubscribes.push(off);
    expect(getAgentKind("fake-roundtrip")).toBe(fake);
    off();
    let caught: unknown;
    try {
      getAgentKind("fake-roundtrip");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownAgentKindError);
    const error = caught as UnknownAgentKindError;
    expect(error.kindId).toBe("fake-roundtrip");
    expect(error.code).toBe("UNKNOWN_AGENT_KIND");
  });

  test("registering a duplicate id throws AgentKindAlreadyRegisteredError carrying the id", () => {
    unsubscribes.push(registerAgentKind(makeFakeKind("fake-dupe", [])));
    let caught: unknown;
    try {
      registerAgentKind(makeFakeKind("fake-dupe", []));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentKindAlreadyRegisteredError);
    const error = caught as AgentKindAlreadyRegisteredError;
    expect(error.kindId).toBe("fake-dupe");
    expect(error.code).toBe("AGENT_KIND_ALREADY_REGISTERED");
  });

  test("resolveKindForScript(interactive) returns the REAL experience kind, delegating to EXPERIENCE_COPILOT_MODULE", () => {
    const kind = resolveKindForScript(SCRIPT_KIND.interactive);
    expect(kind).toBe(getAgentKind("experience"));
    expect(kind.id).toBe("experience");
    expect(kind.servesScriptKinds).toEqual(["interactive"]);
    expect(kind.basePromptServiceKey).toBe("copilot_base");
    expect(kind.skillRootId).toBe("experience");
    // Delegation: the default tool set is EXPERIENCE_COPILOT_MODULE's toolSet
    // projected through the wire-contract tool keys — nothing hand-copied.
    for (const key of COPILOT_TOOL_KEYS) {
      expect(kind.defaultToolSet[key]).toBe(
        EXPERIENCE_COPILOT_MODULE.toolSet[key] === true ? true : undefined,
      );
    }
    // And it smuggles no tool key outside the wire contract.
    for (const key of Object.keys(kind.defaultToolSet)) {
      expect(COPILOT_TOOL_KEYS).toContain(key);
    }
  });

  test("resolveKindForScript(prompt/dice) returns the REAL script kind (AS-7); interactive stays experience", () => {
    for (const scriptKind of [SCRIPT_KIND.prompt, SCRIPT_KIND.dice]) {
      const kind = resolveKindForScript(scriptKind);
      expect(kind).toBe(getAgentKind("script"));
      expect(kind.id).toBe("script");
      expect(kind.servesScriptKinds).toEqual(["prompt", "dice"]);
      expect(kind.basePromptServiceKey).toBe("script_agent_base");
      expect(kind.skillRootId).toBe("script");
      // Delegation: the default tool set is SCRIPT_AGENT_MODULE's toolSet
      // projected through the wire-contract tool keys — nothing hand-copied.
      for (const key of SCRIPT_AGENT_TOOL_KEYS) {
        expect(kind.defaultToolSet[key]).toBe(
          SCRIPT_AGENT_MODULE.toolSet[key] === true ? true : undefined,
        );
      }
      // And it smuggles no tool key outside the wire contract.
      for (const key of Object.keys(kind.defaultToolSet)) {
        expect(SCRIPT_AGENT_TOOL_KEYS).toContain(key);
      }
    }
    // The AS-7 registration leaves the experience mapping untouched.
    expect(resolveKindForScript(SCRIPT_KIND.interactive).id).toBe("experience");
  });

  test("resolveKindForScript is data-driven: a fake kind serving a fresh script-kind value becomes resolvable", () => {
    // The unit's real test: a MINIMAL fake kind registers purely through the
    // public API and the script-kind mapping follows the registered data. AS-7
    // serves every REAL script kind with a built-in (first-registered-wins —
    // a later fake displaces nothing), so the mapping is proven on a SYNTHETIC
    // value no built-in serves.
    const fake = makeFakeKind("fake-fresh-kind", ["fake-fresh" as ScriptKind]);
    unsubscribes.push(registerAgentKind(fake));
    expect(resolveKindForScript("fake-fresh" as ScriptKind)).toBe(fake);
  });

  test("resolveKindForScript(bogus value) throws NoAgentKindForScriptKindError carrying it", () => {
    let caught: unknown;
    try {
      resolveKindForScript("bogus" as ScriptKind);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoAgentKindForScriptKindError);
    expect((caught as NoAgentKindForScriptKindError).scriptKind).toBe("bogus");
  });
});

describe("getAgentKindOf + descriptor context rendering (AS-2b)", () => {
  test("getAgentKindOf<ExperienceAgentContext>(\"experience\").renderContextPackage renders the context package through the descriptor", () => {
    const kind = getAgentKindOf<ExperienceAgentContext>("experience");
    const rendered = kind.renderContextPackage({
      rules: "context.experience.register({})",
      visual: undefined,
      boundVisuals: undefined,
      contract: null,
      rulesTrusted: true,
      testFeedback: null,
      step: "rules",
    });
    // Pins the DESCRIPTOR PATH exists (AS-2b): the kind renders the context
    // package through the registry getter, no direct experience-module call.
    // The byte output itself is pinned by the prompt suite + AS-1.
    expect(rendered.startsWith("# Current working context")).toBe(true);
    expect(rendered).toContain("Authoring step:");
  });
});
