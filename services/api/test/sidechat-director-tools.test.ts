/**
 * The director proposal tools (DIRECTOR_MODE_PLAN Wave 1 / DR-4a) — the two
 * builder-level pins the unit names:
 *
 * - `propose_plan`: a valid plan → the `story-plan` update RecordProposal on
 *   the thread's branch (payload = the NORMALIZED plan + optional summary);
 *   two active events → the plan tool's own model-correctable error text and
 *   NO proposal.
 * - `propose_tracker_template`: the ONE delegate generator is called grounded
 *   in the character card, the branch plan's premise + rules prepended into
 *   focusNotes, and the current template derived through
 *   `trackerTemplateFromChat`; only the `scene` part of the result is
 *   proposed (A9 — a generated objective part never reaches the payload); a
 *   delegate failure and a scene-less generation return error TEXT to the
 *   model; an unbound delegate refuses loudly. DK-5a: the optional
 *   `withClock` ask rides the payload verbatim.
 * - `propose_deck` (DK-5a): a valid deck → the `story-deck` update
 *   RecordProposal on the thread's branch (payload = the proposed cards +
 *   optional summary); an empty deck / a bad suit / a bad shape are refused
 *   by the input schema (the loop's model-correctable validation text) and
 *   produce NO proposal.
 * - `propose_plan` + the DK-1 `at` stamps: a dated task's stamp rides the
 *   payload through normalization; an invalid stamp is refused by the input
 *   schema.
 * - the toggle gating: only enabled keys are served.
 *
 * Pure builder tests (T0/T1): the loaders and the delegate are injected
 * stubs — no DB, no stores, no `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSidechatDirectorTools,
  SIDECHAT_PROPOSE_DECK_TOOL_NAME,
  SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
  SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
  type SidechatDirectorToolsInput,
  type SidechatTrackerGroundingSource,
} from "../src/domain/agent/kinds/sidechat/sidechat-director-tools.js";
import type { TrackerDelegate, TrackerDelegateInput } from "../src/domain/coauthor/tracker/tracker-delegate.js";
// Shared zod input-schema probe over a built ToolSet (takes any ToolSet —
// no per-suite fork).
import { coauthorToolInputSchema as toolInputSchema } from "./provider-boundary-test-builders.js";
import {
  defaultObjectiveState,
  normalizeInsightsConfig,
  normalizeAgentPlan,
  OBJECTIVE_MODE,
  trackerTemplateFromChat,
  type AgentPlan,
} from "@vibe-tavern/domain";
import type { RecordProposal } from "@vibe-tavern/api-contracts";

// The execute-options stub, TYPED from the tool's own signature (the SDK
// hands execute this second param; only toolCallId matters to these tools —
// the sibling plan-tools test stubs the same shape with a `never` cast, but
// the hygiene ratchet caps that idiom, so this file derives the real type).
type DirectorTools = ReturnType<typeof buildSidechatDirectorTools>;
type PlanExecuteOptions = Parameters<NonNullable<DirectorTools["propose_plan"]["execute"]>>[1];
const ctx: PlanExecuteOptions = { messages: [], toolCallId: "call_director_1" };

const OWNER = { chatId: "chat_director", branchId: "branch_director" };

const PLAN: AgentPlan = {
  goal: "Cross the Ashen Sea before the pact expires",
  constraints: ["No ship sails after dusk", "The lantern must stay lit"],
  tasks: [
    { id: "e1", title: "The harbour pact", body: "Seal it at the tide bell.", status: "active" },
    { id: "e2", title: "The storm crossing", body: "", status: "pending" },
  ],
};

const CHARACTER_MD = "# PERSONALITY\nA wary harbour witch.";

/** A chat source whose template carries BOTH parts (scene on, objective on). */
const GROUNDING: SidechatTrackerGroundingSource = {
  insightsConfig: normalizeInsightsConfig({ trackerEnabled: true, objectiveEnabled: true, tracker: {} }),
  insightsObjectiveState: {
    ...defaultObjectiveState(),
    mode: OBJECTIVE_MODE.route,
    tasks: [{ id: "t1", title: "Chart the shallows", status: "pending" as const }],
  },
};

const GROUNDING_TEMPLATE = trackerTemplateFromChat(GROUNDING.insightsConfig, GROUNDING.insightsObjectiveState);
const OBJECTIVE_ONLY_TEMPLATE = trackerTemplateFromChat(
  normalizeInsightsConfig({ objectiveEnabled: true }),
  defaultObjectiveState(),
);
// Fixture guards: these throw at module load (failing the whole file loudly)
// if the domain projection ever stops producing the shapes the tests need.
if (GROUNDING_TEMPLATE === null || GROUNDING_TEMPLATE.scene === null || GROUNDING_TEMPLATE.objective === null) {
  throw new Error("DR-4a test fixture: the grounding source must project a template with BOTH parts");
}
if (OBJECTIVE_ONLY_TEMPLATE === null || OBJECTIVE_ONLY_TEMPLATE.scene !== null) {
  throw new Error("DR-4a test fixture: the objective-only source must project a scene-less template");
}

/** Wire the builder over recording stubs (the delegate wrapper records every
 *  call so the grounding pins read the exact delegate input). */
function makeTools(overrides: {
  toolSet?: Record<string, boolean>;
  delegate?: TrackerDelegate;
  branchPlan?: AgentPlan | null;
}) {
  const delegateCalls: TrackerDelegateInput[] = [];
  const delegate: TrackerDelegate =
    overrides.delegate ?? (async () => ({ trackerTemplate: GROUNDING_TEMPLATE }));
  const input: SidechatDirectorToolsInput = {
    toolSet: overrides.toolSet ?? { propose_plan: true, propose_tracker_template: true },
    owner: OWNER,
    trackerDelegate: async (call, signal) => {
      delegateCalls.push(call);
      return delegate(call, signal);
    },
    loadCharacterProfileMd: () => Promise.resolve(CHARACTER_MD),
    loadBranchPlan: () => Promise.resolve(overrides.branchPlan === undefined ? PLAN : overrides.branchPlan),
    loadTrackerGrounding: () => Promise.resolve(GROUNDING),
  };
  return { tools: buildSidechatDirectorTools(input), delegateCalls };
}

/** Narrow a tracker-tool result to the proposal arm (a string is a failure
 *  the payload pins must never see). */
function expectProposal(result: RecordProposal | string): RecordProposal {
  if (typeof result === "string") throw new Error(`expected a proposal, got error text: ${result}`);
  return result;
}

describe("buildSidechatDirectorTools (DR-4a) — toggle gating", () => {
  test("serves both tools when the profile enables them; a partial set serves only its own key", () => {
    const both = makeTools({}).tools;
    expect(Object.keys(both).sort()).toEqual([
      SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
      SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
    ]);
    const planOnly = makeTools({ toolSet: { propose_plan: true } }).tools;
    expect(Object.keys(planOnly)).toEqual([SIDECHAT_PROPOSE_PLAN_TOOL_NAME]);
    const none = makeTools({ toolSet: {} }).tools;
    expect(none).toEqual({});
  });

  test("the deck key (DK-5a) is served only on its own toggle — the full set serves all three", () => {
    const all = makeTools({
      toolSet: { propose_plan: true, propose_tracker_template: true, propose_deck: true },
    }).tools;
    expect(Object.keys(all).sort()).toEqual(
      [
        SIDECHAT_PROPOSE_DECK_TOOL_NAME,
        SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
        SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
      ].sort(),
    );
    const deckOnly = makeTools({ toolSet: { propose_deck: true } }).tools;
    expect(Object.keys(deckOnly)).toEqual([SIDECHAT_PROPOSE_DECK_TOOL_NAME]);
    // The DMT-34 default above (plan + tracker only) serves NO deck tool —
    // the toggle is the gate, never the builder's presence.
    expect(Object.keys(makeTools({}).tools)).not.toContain(SIDECHAT_PROPOSE_DECK_TOOL_NAME);
  });
});

describe("propose_plan (DR-4a)", () => {
  test("input is an OBJECT root `{ plan, summary? }` — a bare plan is rejected", () => {
    const { tools } = makeTools({});
    // Shared zod input-schema probe (instanceof-narrowed; script-agent-tools /
    // coauthor reuse the same provider-boundary builder).
    const probe = toolInputSchema(tools, "propose_plan");
    expect(probe.safeParse(PLAN).success).toBe(false);
    expect(probe.safeParse({ plan: PLAN }).success).toBe(true);
    expect(probe.safeParse({ plan: PLAN, summary: "Two events" }).success).toBe(true);
  });

  test("a valid plan + summary → story-plan UPDATE proposal on the thread's branch, payload = normalized plan", async () => {
    const { tools } = makeTools({});
    const result = await tools.propose_plan.execute({ plan: PLAN, summary: "Two events, one active" }, ctx);
    expect(result).toEqual({
      kind: "record",
      id: "call_director_1",
      recordType: "story-plan",
      op: "update",
      targetId: OWNER.branchId,
      payload: { plan: normalizeAgentPlan(PLAN), summary: "Two events, one active" },
      status: "pending",
    } satisfies RecordProposal);
  });

  test("summary omitted → the payload carries the plan only", async () => {
    const { tools } = makeTools({});
    const result = await tools.propose_plan.execute({ plan: PLAN }, ctx);
    expect(result.payload).toEqual({ plan: normalizeAgentPlan(PLAN) });
    expect((result.payload as Record<string, unknown>)["summary"]).toBeUndefined();
  });

  test("two active events → the plan tool's error text, no proposal (self-correction pattern)", async () => {
    const { tools } = makeTools({});
    const twoActive: AgentPlan = {
      ...PLAN,
      tasks: [
        { ...PLAN.tasks[0], status: "active" },
        { ...PLAN.tasks[1], status: "active" },
      ],
    };
    await expect(tools.propose_plan.execute({ plan: twoActive }, ctx)).rejects.toThrow(
      "at most one task can be active",
    );
  });

  test("needs no grounding — the loaders are never read", async () => {
    const tools = buildSidechatDirectorTools({
      toolSet: { propose_plan: true },
      owner: OWNER,
      loadCharacterProfileMd: () => Promise.reject(new Error("no character")),
      loadBranchPlan: () => Promise.reject(new Error("no plan")),
      loadTrackerGrounding: () => Promise.reject(new Error("no chat")),
    });
    const result = await tools.propose_plan.execute({ plan: PLAN }, ctx);
    expect(result.recordType).toBe("story-plan");
  });

  test("a task's `at` story-time stamp rides the payload through normalization (DK-1)", async () => {
    const { tools } = makeTools({});
    const dated: AgentPlan = {
      ...PLAN,
      tasks: PLAN.tasks.map((task, index) => (index === 1 ? { ...task, at: { day: 3, part: "night" } } : task)),
    };
    const result = await tools.propose_plan.execute({ plan: dated, summary: "The storm lands at night" }, ctx);
    // The proposal payload is the plan object the wire validated — the dated
    // task keeps its stamp verbatim (the apply sees it; the story clock can
    // then gate the event).
    const payloadPlan = (result.payload as { plan: AgentPlan }).plan;
    expect(payloadPlan.tasks[1]?.at).toEqual({ day: 3, part: "night" });
    expect(payloadPlan.tasks[0]?.at).toBeUndefined();
  });

  test("an invalid `at` stamp is refused by the input schema — the loop's validation text, no proposal", () => {
    const { tools } = makeTools({});
    // Shared zod input-schema probe (instanceof-narrowed; script-agent-tools /
    // coauthor reuse the same provider-boundary builder).
    const probe = toolInputSchema(tools, "propose_plan");
    const badDay = { ...PLAN, tasks: [{ ...PLAN.tasks[0], at: { day: 0, part: "morning" } }] };
    const badPart = { ...PLAN, tasks: [{ ...PLAN.tasks[0], at: { day: 2, part: "dusk" } }] };
    const extraKey = { ...PLAN, tasks: [{ ...PLAN.tasks[0], at: { day: 2, part: null, hour: 9 } }] };
    expect(probe.safeParse({ plan: badDay }).success).toBe(false);
    expect(probe.safeParse({ plan: badPart }).success).toBe(false);
    expect(probe.safeParse({ plan: extraKey }).success).toBe(false);
    // The same rule accepts the valid stamp (the wire rule, one source).
    const good = { ...PLAN, tasks: [{ ...PLAN.tasks[0], at: { day: 2, part: null } }] };
    expect(probe.safeParse({ plan: good }).success).toBe(true);
  });
});

describe("propose_tracker_template (DR-4a)", () => {
  test("keeps ONLY the scene part (A9) — the payload carries scene, never objective", async () => {
    const { tools } = makeTools({});
    const result = expectProposal(
      await tools.propose_tracker_template.execute(
        { action: "create", focusNotes: "Track the tide and the lantern" },
        ctx,
      ),
    );
    expect(result).toEqual({
      kind: "record",
      id: "call_director_1",
      recordType: "tracker-scene",
      op: "update",
      targetId: OWNER.chatId,
      // The generated template carried BOTH parts; only scene survives.
      payload: { scene: GROUNDING_TEMPLATE.scene },
      status: "pending",
    } satisfies RecordProposal);
  });

  test("grounds the delegate: character card, premise + rules prepended into focusNotes, current template via trackerTemplateFromChat", async () => {
    const { tools, delegateCalls } = makeTools({});
    await tools.propose_tracker_template.execute(
      { action: "refine", focusNotes: "Track the tide and the lantern" },
      ctx,
    );
    expect(delegateCalls).toHaveLength(1);
    const call = delegateCalls[0];
    expect(call.action).toBe("refine");
    expect(call.characterProfileMd).toBe(CHARACTER_MD);
    expect(call.focusNotes).toBe(
      "Story premise: Cross the Ashen Sea before the pact expires\n" +
        "Story rules:\n- No ship sails after dusk\n- The lantern must stay lit\n" +
        "Focus notes: Track the tide and the lantern",
    );
    expect(call.currentTemplate).toEqual(GROUNDING_TEMPLATE);
  });

  test("no branch plan → the model's focusNotes ride alone", async () => {
    const { tools, delegateCalls } = makeTools({ branchPlan: null });
    await tools.propose_tracker_template.execute({ action: "create", focusNotes: "Only the weather" }, ctx);
    expect(delegateCalls[0].focusNotes).toBe("Focus notes: Only the weather");
  });

  test("a delegate failure → error text to the model, no proposal", async () => {
    const { tools } = makeTools({
      delegate: async () => {
        throw new Error("provider unreachable");
      },
    });
    const result = await tools.propose_tracker_template.execute({ action: "create" }, ctx);
    expect(typeof result).toBe("string");
    expect(result).toContain("tracker template generation failed: provider unreachable");
  });

  test("a scene-less generation → error text to the model, no proposal", async () => {
    const { tools } = makeTools({
      delegate: async () => ({ trackerTemplate: OBJECTIVE_ONLY_TEMPLATE }),
    });
    const result = await tools.propose_tracker_template.execute({ action: "create" }, ctx);
    expect(typeof result).toBe("string");
    expect(result).toContain("no scene section");
  });

  test("without a bound delegate the call refuses loudly", async () => {
    const tools = buildSidechatDirectorTools({
      toolSet: { propose_tracker_template: true },
      owner: OWNER,
      loadCharacterProfileMd: () => Promise.resolve(CHARACTER_MD),
      loadBranchPlan: () => Promise.resolve(PLAN),
      loadTrackerGrounding: () => Promise.resolve(GROUNDING),
    });
    await expect(tools.propose_tracker_template.execute({ action: "create" }, ctx)).rejects.toThrow(
      "propose_tracker_template: tracker template generation is not configured",
    );
  });

  test("withClock rides the payload verbatim; omitted it stays absent (DK-5a)", async () => {
    const { tools } = makeTools({});
    const withClock = expectProposal(
      await tools.propose_tracker_template.execute({ action: "create", withClock: true }, ctx),
    );
    expect(withClock.payload).toEqual({ scene: GROUNDING_TEMPLATE.scene, withClock: true });
    // The transformation is the APPLY's business (the registry's tracker-scene
    // handler) — the tool's scene is the delegate's output, untouched.
    const withFalse = expectProposal(
      await tools.propose_tracker_template.execute({ action: "create", withClock: false }, ctx),
    );
    expect(withFalse.payload).toEqual({ scene: GROUNDING_TEMPLATE.scene, withClock: false });
    const without = expectProposal(await tools.propose_tracker_template.execute({ action: "create" }, ctx));
    expect((without.payload as Record<string, unknown>).withClock).toBeUndefined();
  });
});

// ─── DK-5a: the deck proposal ────────────────────────────────────────────────

/** The proposed twist cards (the wire card shape; the suits typed as their
 *  literal union so the fixture is assignable to the tool input). */
const DECK_CARDS: Array<{
  id: string;
  suit: "threat" | "mystery";
  title: string;
  body: string;
}> = [
  {
    id: "prop_threat_1",
    suit: "threat",
    title: "The harbour watch turns hostile",
    body: "The guards demand the ledger at dusk.",
  },
  {
    id: "prop_mystery_1",
    suit: "mystery",
    title: "A tide map under the floorboards",
    body: "Marked with the pact seal.",
  },
];

describe("propose_deck (DK-5a)", () => {
  test("a valid deck + summary → story-deck UPDATE proposal on the thread's branch, payload = { cards, summary }", async () => {
    const { tools } = makeTools({ toolSet: { propose_deck: true } });
    const result = await tools.propose_deck.execute(
      { cards: DECK_CARDS, summary: "Two twists for the harbour arc" },
      ctx,
    );
    expect(result).toEqual({
      kind: "record",
      id: "call_director_1",
      recordType: "story-deck",
      op: "update",
      targetId: OWNER.branchId,
      payload: { cards: DECK_CARDS, summary: "Two twists for the harbour arc" },
      status: "pending",
    } satisfies RecordProposal);
  });

  test("summary omitted → the payload carries the cards only", async () => {
    const { tools } = makeTools({ toolSet: { propose_deck: true } });
    const result = await tools.propose_deck.execute({ cards: DECK_CARDS }, ctx);
    expect(result.payload).toEqual({ cards: DECK_CARDS });
    expect((result.payload as Record<string, unknown>).summary).toBeUndefined();
  });

  test("the input contract refuses an empty deck, a bad suit and bad shapes — the loop's self-correction text, no proposal", () => {
    const { tools } = makeTools({ toolSet: { propose_deck: true } });
    // Shared zod input-schema probe (instanceof-narrowed; script-agent-tools /
    // coauthor reuse the same provider-boundary builder).
    const probe = toolInputSchema(tools, "propose_deck");
    // No cards at all / an EMPTY deck — the model must propose at least one
    // card (the packet's self-correction rule).
    expect(probe.safeParse({}).success).toBe(false);
    expect(probe.safeParse({ cards: [] }).success).toBe(false);
    // A suit outside the five fixed ones is refused (the wire mirror's rule).
    expect(
      probe.safeParse({
        cards: [{ id: "c1", suit: "fortune", title: "The gypsy card", body: "" }],
      }).success,
    ).toBe(false);
    // Shape misses: a bare array (no OBJECT root), cards as a string, a card
    // missing its body, extra keys on the card (strict mirror).
    expect(probe.safeParse(DECK_CARDS).success).toBe(false);
    expect(probe.safeParse({ cards: "two cards" }).success).toBe(false);
    expect(
      probe.safeParse({
        cards: [{ id: "c1", suit: "threat", title: "No body here" }],
      }).success,
    ).toBe(false);
    expect(
      probe.safeParse({
        cards: [{ id: "c1", suit: "threat", title: "Extra", body: "", weight: 2 }],
      }).success,
    ).toBe(false);
    // And the well-formed deck passes.
    expect(probe.safeParse({ cards: DECK_CARDS }).success).toBe(true);
  });

  test("needs no grounding — the loaders are never read", async () => {
    const tools = buildSidechatDirectorTools({
      toolSet: { propose_deck: true },
      owner: OWNER,
      loadCharacterProfileMd: () => Promise.reject(new Error("no character")),
      loadBranchPlan: () => Promise.reject(new Error("no plan")),
      loadTrackerGrounding: () => Promise.reject(new Error("no chat")),
    });
    const result = await tools.propose_deck.execute({ cards: DECK_CARDS }, ctx);
    expect(result.recordType).toBe("story-deck");
    expect(result.targetId).toBe(OWNER.branchId);
  });
});
