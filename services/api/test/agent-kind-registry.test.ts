/**
 * Agent-kind registry (AGENT_SHELL_PLAN, Wave 1 / AS-2a).
 *
 * Pins the public registry contract: the real `experience` kind
 * self-registers at module init (delegating to EXPERIENCE_COPILOT_MODULE),
 * register/unsubscribe round-trips, duplicate-id / unknown-id / unresolvable-
 * script-kind throw their typed errors, and — the unit's real test — a
 * MINIMAL FAKE KIND registers and resolves purely through the public API,
 * proving the descriptor and mapping are data-driven, not experience-bound.
 *
 * Cleanup: every fake's unsubscribe is collected and called in afterAll —
 * there is no registry reset (and none is needed).
 *
 * Order note: the "prompt/dice throw today" test runs BEFORE the test that
 * registers a fake serving "prompt" (kept until afterAll) — bun executes
 * tests in declaration order within a file.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { z } from "zod";
import { SCRIPT_KIND, type ScriptKind } from "@vibe-tavern/domain";
import { COPILOT_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import { EXPERIENCE_COPILOT_MODULE } from "../src/domain/interactive/copilot/experience-copilot-module.js";
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

/** A minimal fake kind — the proof the registry is experience-agnostic. */
function makeFakeKind(id: string, servesScriptKinds: readonly ScriptKind[]): AgentKind {
  return {
    id,
    servesScriptKinds,
    basePromptServiceKey: `${id}_base`,
    skillRootId: id,
    toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
    defaultToolSet: { fake_tool: true },
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

  test("resolveKindForScript(prompt/dice) throws NoAgentKindForScriptKindError today", () => {
    // Documented current state: only "experience" is registered and it serves
    // interactive — prompt/dice have no kind YET. AS-7 will flip this when
    // the script kind registers.
    for (const scriptKind of [SCRIPT_KIND.prompt, SCRIPT_KIND.dice]) {
      let caught: unknown;
      try {
        resolveKindForScript(scriptKind);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NoAgentKindForScriptKindError);
      const error = caught as NoAgentKindForScriptKindError;
      expect(error.scriptKind).toBe(scriptKind);
      expect(error.code).toBe("NO_AGENT_KIND_FOR_SCRIPT_KIND");
    }
  });

  test("resolveKindForScript is data-driven: a fake kind serving prompt becomes resolvable", () => {
    // The unit's real test: a MINIMAL fake kind registers purely through the
    // public API and the script-kind mapping follows the registered data —
    // AS-7's script kind will do exactly this from kinds/script-kind.ts.
    const fake = makeFakeKind("fake-prompt-kind", [SCRIPT_KIND.prompt]);
    unsubscribes.push(registerAgentKind(fake));
    expect(resolveKindForScript(SCRIPT_KIND.prompt)).toBe(fake);
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
