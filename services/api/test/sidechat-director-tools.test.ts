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
 *   model; an unbound delegate refuses loudly.
 * - the toggle gating: only enabled keys are served.
 *
 * Pure builder tests (T0/T1): the loaders and the delegate are injected
 * stubs — no DB, no stores, no `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSidechatDirectorTools,
  SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
  SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
  type SidechatDirectorToolsInput,
  type SidechatTrackerGroundingSource,
} from "../src/domain/agent/kinds/sidechat/sidechat-director-tools.js";
import type { TrackerDelegate, TrackerDelegateInput } from "../src/domain/coauthor/tracker/tracker-delegate.js";
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
});

describe("propose_plan (DR-4a)", () => {
  test("input is an OBJECT root `{ plan, summary? }` — a bare plan is rejected", () => {
    const { tools } = makeTools({});
    const probe = tools as unknown as Record<
      string,
      { inputSchema: { safeParse(value: unknown): { success: boolean } } }
    >;
    expect(probe.propose_plan.inputSchema.safeParse(PLAN).success).toBe(false);
    expect(probe.propose_plan.inputSchema.safeParse({ plan: PLAN }).success).toBe(true);
    expect(probe.propose_plan.inputSchema.safeParse({ plan: PLAN, summary: "Two events" }).success).toBe(true);
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
});
