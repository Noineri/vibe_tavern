/**
 * StoryPlanStrip — DIRECTOR_MODE_PLAN DR-11.
 *
 * Pins the strip's own contract at the panel seam: renders NOTHING while the
 * active branch's plan is empty (the chat pane's byte-identical state); the
 * collapsed row shows the current event + the remaining count with ONLY
 * «Позвать режиссёра» (no editor button — §1); the curtain header's action
 * order is §5's («Проверить сейчас» · «Редактор плана» · «Позвать
 * режиссёра») with the §9 phone own-row wrapper; «Проверить сейчас» calls
 * the goal tracker's existing check action (the objective zone's, P3); the
 * call button disables while the sidechat streams (the mirror store) and,
 * since DR-12, runs the store action by default (the prop stays an
 * override); the passed-check flash (R4) — «Выполнено:
 * <event>» on the success tint for the parked ~6 s timer, then the refreshed
 * plan's next event, one refresh GET per objective change (never a second
 * fetch path); the all-done row «План сюжета выполнен» keeps the strip
 * mounted (A8); the locale tables carry the RU canon (§4/§5/§9, byte-exact).
 *
 * Runner: bun:test + happy-dom. The snapshot + streaming-mirror stores are
 * exercised for real (seeded/reset per test); `useT` rides the shared i18n
 * context seam (the flash key interpolated from the bundled EN table, every
 * other key echoing raw — the house pattern); the objective check action and
 * `globalThis.fetch` (the branch-plan GET through the real use-agent-plan
 * seam) are mocked — the StoryPlanProposalCard.test.tsx /
 * objective-zone.test.tsx precedents. Per-test branch ids keep the
 * module-global plan cache entries disjoint.
 *
 * The flash timer is pinned WITHOUT fake timers (bun has no mock.timers and
 * jest fake timers freeze React's passive-effect scheduler under happy-dom —
 * ImageGenPane.test.tsx's finding): the test passes setTimeout through to
 * the REAL timer, remembers the ~6 s callback, and fires it manually.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentPlan, AgentPlanTask } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useAgentStreamingStore } from "../../../stores/agent-streaming-store.js";
import type { AppSnapshot } from "../../../api/types.js";

const mocks = {
  checkObjectiveCompletionAction: mock(),
  callDirector: mock(),
};
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");

// The flash label interpolates the model's event title — pin the rendered
// "Done: <title>" line; every other key echoes raw (the house pattern).
installI18nContextSeam({ interpolateKeys: ["agent_plan_story_flash_done"] });

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  checkObjectiveCompletionAction: mocks.checkObjectiveCompletionAction,
}));

// DR-12: the strip's default handler runs the store action — mock it here
// (load-time copy, R15) so the strip tests never touch the network seam.
const realCallDirectorStore = { ...(await import("../../../stores/sidechat-call-director-store.js")) };
mock.module("../../../stores/sidechat-call-director-store.js", () => ({
  ...realCallDirectorStore,
  callDirector: mocks.callDirector,
}));

let StoryPlanStrip: typeof import("./StoryPlanStrip.js").StoryPlanStrip;
let STORY_PLAN_FLASH_MS: number;
beforeAll(async () => {
  const mod = await import("./StoryPlanStrip.js");
  StoryPlanStrip = mod.StoryPlanStrip;
  STORY_PLAN_FLASH_MS = mod.STORY_PLAN_FLASH_MS;
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function task(id: string, title: string, body: string, status: AgentPlanTask["status"]): AgentPlanTask {
  return { id, title, body, status };
}

const EMPTY_PLAN: AgentPlan = { goal: "", constraints: [], tasks: [] };
/** §4's board: one completed, the fridge raid current, two after it. */
const PLAN_V1: AgentPlan = {
  goal: "A stray cat became a young man overnight",
  constraints: [],
  tasks: [
    task("ev0", "The morning after", "", "completed"),
    task("ev1", "The fridge raid", "Archie opens the fridge himself.", "active"),
    task("ev2", "House rules", "", "pending"),
    task("ev3", "The neighbour noticed", "", "pending"),
  ],
};
/** The follow-back result once the tracker's check completes ev1. */
const PLAN_V2: AgentPlan = {
  ...PLAN_V1,
  tasks: [
    task("ev0", "The morning after", "", "completed"),
    task("ev1", "The fridge raid", "Archie opens the fridge himself.", "completed"),
    task("ev2", "House rules", "", "active"),
    task("ev3", "The neighbour noticed", "", "pending"),
  ],
};

/** Seed the ACTIVE chat the strip reads ids and the tracker state from
 *  (the StoryPlanProposalCard seed pattern — a minimal wire double through
 *  `ingestSnapshot`; the double-cast form keeps the hygiene `as-never`
 *  ratchet at its budget). */
function seedChat(branchId: string, goals: Array<{ id: string; status: string }>): void {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: {
      id: "chat-1",
      activeBranchId: branchId,
      insightsConfig: { objectiveEnabled: true, trackerEnabled: false },
      insightsObjectiveState: {
        mode: "goals",
        objectiveDescription: "",
        tasks: [],
        longTermGoal: null,
        shortTermGoals: goals.map((goal) => ({ id: goal.id, description: goal.id, status: goal.status })),
        autoCheckFrequency: 1,
        autoCheckEventCount: 0,
        contextWindow: 6,
        injectionDepth: 1,
        generatePrompt: "",
        checkPrompt: "",
        injectPrompt: "",
      },
    } as unknown as AppSnapshot["activeChat"],
  } as unknown as AppSnapshot);
}

// ─── The plan GET through the real use-agent-plan seam ──────────────────────

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const plansByBranch = new Map<string, AgentPlan>();
const planGetUrls: string[] = [];

beforeEach(() => {
  plansByBranch.clear();
  planGetUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/plan")) {
      planGetUrls.push(url);
      const branchId = url.split("/branches/")[1]?.split("/")[0] ?? "";
      return new Response(JSON.stringify({ plan: plansByBranch.get(branchId) ?? EMPTY_PLAN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  mocks.checkObjectiveCompletionAction.mockReset();
  mocks.callDirector.mockReset();
  mocks.callDirector.mockResolvedValue(undefined);
  useAgentStreamingStore.setState({ streaming: {} });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  useSnapshotStore.setState({ activeChat: null });
  useAgentStreamingStore.setState({ streaming: {} });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

/** Mount the strip for a seeded chat + served plan and wait for the row. */
async function mountStrip(
  over: {
    plan?: AgentPlan;
    branchId?: string;
    goals?: Array<{ id: string; status: string }>;
    onCallDirector?: () => void;
  } = {},
) {
  const branchId = over.branchId ?? "b1";
  plansByBranch.set(branchId, over.plan ?? PLAN_V1);
  seedChat(branchId, over.goals ?? [
    { id: "ev0", status: "completed" },
    { id: "ev1", status: "active" },
    { id: "ev2", status: "pending" },
    { id: "ev3", status: "pending" },
  ]);
  const view = render(<StoryPlanStrip onCallDirector={over.onCallDirector} />);
  await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("The fridge raid"));
  return view;
}

// ─── The strip's own contract ────────────────────────────────────────────────

describe("StoryPlanStrip (DR-11)", () => {
  it("renders NOTHING while the active branch's plan is empty (the pane's byte-identical state)", async () => {
    plansByBranch.set("b9", EMPTY_PLAN);
    seedChat("b9", []);
    const view = render(<StoryPlanStrip />);
    // The one mount GET settles; the entry stays empty → no panel, ever.
    await waitFor(() => expect(planGetUrls).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(view.queryByTestId("agent-plan-panel")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("collapsed row: the current event + remaining count, ONLY «Позвать режиссёра» (no editor button)", async () => {
    const view = await mountStrip();
    const row = view.getByTestId("agent-plan-panel");
    expect(row.getAttribute("data-state")).toBe("collapsed");
    expect(row.textContent).toContain("The fridge raid");
    expect(row.textContent).toContain("· 3 agent_plan_remaining");
    expect(view.getByTestId("agent-plan-glyph-active")).toBeDefined();
    expect(view.queryByTestId("agent-plan-open-editor")).toBeNull();
    expect(view.getByTestId("story-plan-call-director").textContent).toBe("story_plan_call_director");
  });

  it("curtain overlays below the constant row (no layout shift) with §5's header order + §9's phone own-row wrapper", async () => {
    const view = await mountStrip();
    fireEvent.click(view.getByTestId("agent-plan-toggle"));
    const panel = view.getByTestId("agent-plan-panel");
    expect(panel.className).toContain("relative");
    const curtain = view.getByTestId("agent-plan-curtain");
    expect(curtain.className).toContain("absolute");
    expect(curtain.className).toContain("left-0 right-0 top-full");
    // The in-flow row STAYS (constant height) while the overlay is open.
    expect(view.getByTestId("agent-plan-toggle")).toBeDefined();
    // §5's interleaved order, exact: check · editor · call inside the wrapper.
    const wrapper = view.getByTestId("agent-plan-curtain-header-actions");
    expect(wrapper.className).toContain("w-full");
    expect(wrapper.className).toContain("md:contents");
    expect([...wrapper.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual([
      "story-plan-check-now",
      "agent-plan-open-editor",
      "story-plan-call-director",
    ]);
  });

  it("«Проверить сейчас» calls the goal tracker's existing manual check (P3)", async () => {
    mocks.checkObjectiveCompletionAction.mockResolvedValue(undefined);
    const view = await mountStrip();
    fireEvent.click(view.getByTestId("agent-plan-toggle"));
    fireEvent.click(view.getByTestId("story-plan-check-now"));
    expect(mocks.checkObjectiveCompletionAction).toHaveBeenCalledTimes(1);
    expect(mocks.checkObjectiveCompletionAction).toHaveBeenCalledWith("chat-1", expect.any(AbortSignal));
  });

  it("«Позвать режиссёра» (DR-12): the default handler runs the store action; disabled while streaming; an explicit prop overrides", async () => {
    // The DEFAULT mount (no prop): DR-12 wires the store action — enabled,
    // and a click calls it with the strip's chat + branch.
    const view = await mountStrip({ branchId: "b1" });
    expect(view.getByTestId("story-plan-call-director").getAttribute("disabled")).toBeNull();
    fireEvent.click(view.getByTestId("story-plan-call-director"));
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    expect(mocks.callDirector.mock.calls[0]).toEqual(["chat-1", "b1"]);
    view.unmount();

    // The sidechat of this chat+branch streams (the mirror): disabled, and a
    // click fires nothing.
    const onCallDirector = mock();
    const view2 = await mountStrip({ branchId: "b2", onCallDirector });
    useAgentStreamingStore.setState({ streaming: { "chat:chat-1:b2:sidechat-ooc": true } });
    await waitFor(() => expect(view2.getByTestId("story-plan-call-director").getAttribute("disabled")).toBe(""));
    fireEvent.click(view2.getByTestId("story-plan-call-director"));
    expect(onCallDirector).not.toHaveBeenCalled();
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    view2.unmount();

    // Not streaming + an explicit prop (the override path): one fire per click.
    const view3 = await mountStrip({ branchId: "b3", onCallDirector });
    expect(view3.getByTestId("story-plan-call-director").getAttribute("disabled")).toBeNull();
    fireEvent.click(view3.getByTestId("story-plan-call-director"));
    expect(onCallDirector).toHaveBeenCalledTimes(1);
  });

  it("the passed check flashes «Выполнено: <event>» for the parked ~6 s, then the next event — one refresh GET per objective change", async () => {
    // Capture the strip's parked timer: pass through to the REAL setTimeout,
    // remember the ~6 s callback, fire it manually (see the file header).
    // The box defeats TS's closure narrowing (assignment happens inside the
    // patched setTimeout, invisible to control flow).
    const flashTimerBox: { current: { delay: number; fire: () => void } | null } = { current: null };
    globalThis.setTimeout = ((callback: () => void, delay?: number, ...rest: unknown[]) => {
      const handle = originalSetTimeout(callback, delay, ...rest);
      if (delay === STORY_PLAN_FLASH_MS) flashTimerBox.current = { delay, fire: callback };
      return handle;
    }) as typeof setTimeout;

    const view = await mountStrip({ branchId: "b5" });
    expect(planGetUrls).toHaveLength(1);

    // The check passed server-side: the goal for the plan's CURRENT event
    // (ev1) turns completed, ev2 becomes active, and the follow-back wrote
    // the plan row (the GET now serves it).
    plansByBranch.set("b5", PLAN_V2);
    await act(async () => {
      seedChat("b5", [
        { id: "ev0", status: "completed" },
        { id: "ev1", status: "completed" },
        { id: "ev2", status: "active" },
        { id: "ev3", status: "pending" },
      ]);
    });

    // The flash row: the completed glyph + the success-tinted «Выполнено:
    // <event>», the count already from the REFRESHED plan (§4: «· 2
    // осталось»), and exactly one refresh GET — never a second fetch path.
    await waitFor(() => expect(view.getByTestId("agent-plan-glyph-completed")).toBeDefined());
    expect(view.getByText("Done: The fridge raid")).toBeDefined();
    expect(view.getByTestId("agent-plan-panel").textContent).toContain("· 2 agent_plan_remaining");
    expect(planGetUrls).toHaveLength(2);

    // The parked timer: ~6 s, then the row moves to the next event.
    expect(flashTimerBox.current?.delay).toBe(STORY_PLAN_FLASH_MS);
    expect(STORY_PLAN_FLASH_MS).toBe(6000);
    act(() => flashTimerBox.current?.fire());
    await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("House rules"));
    expect(view.queryByText("Done: The fridge raid")).toBeNull();
  });

  it("all done: «План сюжета выполнен» — the strip STAYS (A8)", async () => {
    plansByBranch.set("b6", {
      goal: "Premise",
      constraints: [],
      tasks: [
        task("ev1", "The fridge raid", "", "completed"),
        task("ev2", "House rules", "", "completed"),
      ],
    });
    seedChat("b6", [
      { id: "ev1", status: "completed" },
      { id: "ev2", status: "completed" },
    ]);
    const view = render(<StoryPlanStrip />);
    // No current event → the done line, and the panel stays mounted.
    await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("agent_plan_story_done"));
    const row = view.getByTestId("agent-plan-panel");
    expect(row.textContent).toContain("· 0 agent_plan_remaining");
    expect(view.getByTestId("agent-plan-glyph-completed")).toBeDefined();
  });
});

// ─── The RU canon (mock §4/§5/§9 + plan bullets, byte-exact) ────────────────

describe("StoryPlanStrip — locale canon (DR-11)", () => {
  it("ru.json carries the mock's strings verbatim; en carries the English twins", () => {
    expect(ru.story_plan_call_director).toBe("Позвать режиссёра");
    expect(ru.story_plan_check_now).toBe("Проверить сейчас");
    expect(ru.agent_plan_story_done).toBe("План сюжета выполнен");
    expect(ru.agent_plan_story_flash_done).toBe("Выполнено: {title}");
    expect(en.story_plan_call_director).toBe("Call the director");
    expect(en.story_plan_check_now).toBe("Check now");
    expect(en.agent_plan_story_done).toBe("Story plan complete");
    expect(en.agent_plan_story_flash_done).toBe("Done: {title}");
  });
});
