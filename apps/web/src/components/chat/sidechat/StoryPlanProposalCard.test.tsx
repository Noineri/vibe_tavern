/**
 * StoryPlanProposalCard — DIRECTOR_MODE_PLAN DR-10a.
 *
 * Pins the card's own contract: the revision markers (new / changed /
 * removed, a pure diff by id against the STORED branch plan, mock §6's row
 * order); the current event's body; the A5 replace warning only when Accept
 * would drop goals that are not plan events (a foreign item id, an open
 * long-term goal; never for a non-active target branch); the A6 auto-check
 * row only at frequency 0, off by default, its value riding Accept as
 * `enableAutoCheck`; the resolved lines (stored status, reload-surviving);
 * Accept calls apply with the right body, ingests the companion plan into
 * the useAgentPlan cache (no second GET) and refetches the chat; Reject
 * resolves without touching the chat; the typed already-resolved 409; other
 * failures toast and keep the card pending; an unshaped payload renders
 * empty without a throw; the locale tables carry the RU canon (mock §1/§6,
 * byte-exact) and the `propose_plan` tool label is pinned.
 *
 * Runner: bun:test + happy-dom. The snapshot store is exercised for real
 * (seeded/reset per test); `useT`, the proposals API, `fetchChatAction`,
 * sonner, and `globalThis.fetch` (the plan GET through the real
 * use-agent-plan seam) are mocked — the objective-zone.test.tsx /
 * ObjectiveProposalCard.test.tsx precedents. Per-test branch ids keep the
 * module-global plan cache entries disjoint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentPlan, AgentPlanTask, RecordProposal } from "@vibe-tavern/api-contracts";
import type { ObjectiveState } from "@vibe-tavern/domain";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { fireEvent, render, renderHook, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import type { AppSnapshot } from "../../../api/types.js";

const mocks = {
  applyStoryPlanProposal: mock(),
  rejectStoryPlanProposal: mock(),
  fetchChatAction: mock(),
  toastError: mock(),
};
const realProposalsApi = await import("../../../api/agent-thread-proposals-api.js");
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
const realSonner = await import("sonner");

installI18nContextSeam();

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: mocks.toastError },
}));

mock.module("../../../api/agent-thread-proposals-api.js", () => ({
  ...realProposalsApi,
  applyStoryPlanProposal: mocks.applyStoryPlanProposal,
  rejectStoryPlanProposal: mocks.rejectStoryPlanProposal,
}));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  fetchChatAction: mocks.fetchChatAction,
}));

let StoryPlanProposalCard: typeof import("./StoryPlanProposalCard.js").StoryPlanProposalCard;
let diffStoryPlanEvents: typeof import("./StoryPlanProposalCard.js").diffStoryPlanEvents;
let willAcceptReplaceForeignGoals: typeof import("./StoryPlanProposalCard.js").willAcceptReplaceForeignGoals;
beforeAll(async () => {
  ({ StoryPlanProposalCard, diffStoryPlanEvents, willAcceptReplaceForeignGoals } = await import(
    "./StoryPlanProposalCard.js"
  ));
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function task(id: string, title: string, body: string, status: AgentPlanTask["status"]): AgentPlanTask {
  return { id, title, body, status };
}

const planOf = (tasks: AgentPlanTask[]): AgentPlan => ({ goal: "Cat becomes human", constraints: [], tasks });

/** The mock §6 revision: stored [ev1..ev5], proposed drops ev4, adds ev6,
 *  rewrites ev2's body and ev3's body. */
const STORED_TASKS: AgentPlanTask[] = [
  task("ev1", "Morning after the transformation", "", "completed"),
  task("ev2", "Fridge raid", "", "pending"),
  task("ev3", "House rules", "", "active"),
  task("ev4", "Neighbour noticed something", "", "pending"),
  task("ev5", "First grounding night", "", "pending"),
];
const PROPOSED_TASKS: AgentPlanTask[] = [
  task("ev1", "Morning after the transformation", "", "completed"),
  task("ev2", "Fridge raid", "Raid happens before the house rules", "completed"),
  task("ev3", "House rules", "Noah said do not jump out the window", "active"),
  task("ev6", "Pet store trip", "", "pending"),
  task("ev5", "First grounding night", "", "pending"),
];
const APPLIED_PLAN = planOf([
  task("ev1", "Morning after the transformation", "", "completed"),
  task("ev2", "Fridge raid", "Raid happens before the house rules", "completed"),
  task("ev3", "House rules", "Noah said do not jump out the window", "active"),
]);

/** The plan each branch GET serves, keyed by the per-test branch id. */
const storedPlansByBranch = new Map<string, AgentPlan>();

const originalFetch = globalThis.fetch;
const fetchCalls: string[] = [];
beforeEach(() => {
  storedPlansByBranch.clear();
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes("/plan")) {
      const branchId = url.split("/branches/")[1]?.split("/")[0] ?? "";
      return new Response(JSON.stringify({ plan: storedPlansByBranch.get(branchId) ?? planOf([]) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  mocks.applyStoryPlanProposal.mockReset();
  mocks.rejectStoryPlanProposal.mockReset();
  mocks.fetchChatAction.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  useSnapshotStore.setState({ activeChat: null });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Seed the ACTIVE chat the card reads the tracker state and ids from (the
 *  ObjectiveProposalCard seed pattern: minimal wire double through
 *  `ingestSnapshot`). */
function seedChat(over: {
  branchId: string;
  items?: { id: string; description: string; status: string }[];
  mode?: "goals" | "route";
  longTerm?: { description: string; status: string } | null;
  autoCheckFrequency?: number;
}) {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: {
      id: "c1",
      activeBranchId: over.branchId,
      insightsConfig: { objectiveEnabled: true, trackerEnabled: false },
      insightsObjectiveState: {
        mode: over.mode ?? "goals",
        objectiveDescription: "",
        tasks: over.items ?? [],
        longTermGoal: over.longTerm ?? null,
        shortTermGoals: over.items ?? [],
        autoCheckFrequency: over.autoCheckFrequency ?? 0,
        autoCheckEventCount: 0,
        contextWindow: 6,
        injectionDepth: 1,
        generatePrompt: "",
        checkPrompt: "",
        injectPrompt: "",
      },
    },
  } as unknown as AppSnapshot);
}

function proposal(over: Partial<RecordProposal> & { payload?: unknown }): RecordProposal {
  return {
    kind: "record",
    id: "tc-plan",
    recordType: "story-plan",
    op: "update",
    targetId: "b1",
    payload: {
      plan: planOf(PROPOSED_TASKS),
      summary: "Kitchen happened earlier — shifting the events",
    },
    status: "pending",
    ...over,
  };
}

/** Mount a pending card whose stored plan (branch GET) + active chat are
 *  seeded, and wait for the review block (the stored plan's GET settles). */
async function mountCard(over?: {
  stored?: AgentPlan;
  branchId?: string;
  chat?: Parameters<typeof seedChat>[0];
  onResolved?: (proposal: RecordProposal) => void;
}) {
  const branchId = over?.branchId ?? "b1";
  storedPlansByBranch.set(branchId, over?.stored ?? planOf(STORED_TASKS));
  seedChat({ branchId, ...(over?.chat ?? {}) });
  const view = render(
    <StoryPlanProposalCard
      proposal={proposal({ targetId: branchId })}
      threadId="thread-1"
      {...(over?.onResolved !== undefined ? { onResolved: over.onResolved } : {})}
    />,
  );
  await waitFor(() => expect(view.getByTestId("story-plan-proposal-events")).not.toBeNull());
  return view;
}

// ─── The pure diff (a pure diff by id — DR-10a / mock §6) ───────────────────

describe("diffStoryPlanEvents", () => {
  it("marks new / changed / removed by id and reproduces the mock §6 row order", () => {
    const rows = diffStoryPlanEvents(STORED_TASKS, PROPOSED_TASKS);
    expect(rows.map((row) => [row.task.id, row.marker])).toEqual([
      ["ev1", null],
      ["ev2", "changed"],
      ["ev3", "changed"],
      ["ev6", "new"],
      ["ev4", "removed"],
      ["ev5", null],
    ]);
  });

  it("identical plans carry no markers; an empty stored plan marks everything new", () => {
    expect(diffStoryPlanEvents(STORED_TASKS, STORED_TASKS).every((row) => row.marker === null)).toBe(true);
    expect(
      diffStoryPlanEvents([], STORED_TASKS)
        .map((row) => row.marker)
        .every((marker) => marker === "new"),
    ).toBe(true);
  });

  it("a status-only change carries no marker (status is the glyph's business)", () => {
    const rows = diffStoryPlanEvents(
      [task("a", "Title", "Body", "pending")],
      [task("a", "Title", "Body", "active")],
    );
    expect(rows[0]!.marker).toBeNull();
  });

  it("a reorder emits both tasks unmarked, never removed+new", () => {
    const rows = diffStoryPlanEvents(
      [task("a", "A", "", "pending"), task("b", "B", "", "pending")],
      [task("b", "B", "", "pending"), task("a", "A", "", "pending")],
    );
    expect(rows.map((row) => row.marker)).toEqual([null, null]);
    expect(rows.map((row) => row.task.id)).toEqual(["a", "b"]);
  });
});

// ─── A5: the replace warning ────────────────────────────────────────────────

describe("willAcceptReplaceForeignGoals", () => {
  const ids = (values: string[]) => new Set(values);
  const goalsState = {
    mode: "goals" as const,
    objectiveDescription: "",
    tasks: [],
    longTermGoal: null,
    shortTermGoals: [{ id: "ev3", description: "House rules", status: "active" }],
    autoCheckFrequency: 0,
    autoCheckEventCount: 0,
    contextWindow: 6,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
    useChatModel: true,
    providerProfileId: null,
    model: null,
  } satisfies ObjectiveState;

  it("no warning while every current goal id is a proposed event id", () => {
    expect(willAcceptReplaceForeignGoals(goalsState, ids(["ev1", "ev3", "ev6"]), "b1", "b1")).toBe(false);
  });

  it("warns for a foreign goal id, an open long-term goal, and route-mode tasks alike", () => {
    expect(willAcceptReplaceForeignGoals(goalsState, ids(["ev1"]), "b1", "b1")).toBe(true);
    expect(
      willAcceptReplaceForeignGoals(
        { ...goalsState, shortTermGoals: [], longTermGoal: { description: "Freedom", status: "pending" } },
        ids(["ev1"]),
        "b1",
        "b1",
      ),
    ).toBe(true);
    expect(
      willAcceptReplaceForeignGoals(
        { ...goalsState, mode: "route", tasks: [{ id: "route-1", description: "Old", status: "pending" }] },
        ids(["ev1"]),
        "b1",
        "b1",
      ),
    ).toBe(true);
  });

  it("a completed long-term goal and a non-active target branch never warn", () => {
    expect(
      willAcceptReplaceForeignGoals(
        { ...goalsState, shortTermGoals: [], longTermGoal: { description: "Freedom", status: "completed" } },
        ids(["ev1"]),
        "b1",
        "b1",
      ),
    ).toBe(false);
    expect(willAcceptReplaceForeignGoals(goalsState, ids(["ev1"]), "b1", "b-other")).toBe(false);
  });
});

// ─── The card ───────────────────────────────────────────────────────────────

describe("StoryPlanProposalCard (DR-10a)", () => {
  it("renders the revision rows with markers and the current event's body (mock §6)", async () => {
    const { getAllByTestId, getByTestId } = await mountCard({ branchId: "b-revision-rows" });
    const rows = getAllByTestId("story-plan-event");
    expect(rows.map((row) => [row.getAttribute("data-event-id"), row.getAttribute("data-marker")])).toEqual([
      ["ev1", ""],
      ["ev2", "changed"],
      ["ev3", "changed"],
      ["ev6", "new"],
      ["ev4", "removed"],
      ["ev5", ""],
    ]);
    expect(getByTestId("story-plan-proposal-summary").textContent).toBe("Kitchen happened earlier — shifting the events");
    // The current event (first active — ev3) shows its body; no other row does.
    expect(rows[2]!.textContent).toContain("Noah said do not jump out the window");
    expect(rows.filter((row) => row.textContent!.includes("window"))).toHaveLength(1);
    expect(getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("story-plan-proposal-accept").getAttribute("disabled")).toBeNull();
  });

  it("A5: the warning line renders ONLY when Accept would drop goals not from the plan", async () => {
    const foreign = await mountCard({
      branchId: "b-warn",
      chat: { branchId: "b-warn", items: [{ id: "ev3", description: "House rules", status: "active" }, { id: "foreign-1", description: "Old goal", status: "pending" }] },
    });
    expect(foreign.getByTestId("story-plan-replace-warning").textContent).toBe(
      "agent.story_plan_proposal.warning_replace_goals",
    );
    foreign.unmount();

    const fromPlan = await mountCard({
      branchId: "b-nowarn",
      chat: { branchId: "b-nowarn", items: PROPOSED_TASKS.map((t) => ({ id: t.id, description: t.title, status: t.status })) },
    });
    expect(fromPlan.queryByTestId("story-plan-replace-warning")).toBeNull();
  });

  it("A6: the auto-check row shows only at frequency 0, off by default; its value rides Accept", async () => {
    const off = await mountCard({ branchId: "b-freq1", chat: { branchId: "b-freq1", autoCheckFrequency: 1 } });
    expect(off.queryByTestId("story-plan-auto-check-row")).toBeNull();
    off.unmount();

    const { getByRole, getByTestId, queryByTestId } = await mountCard({ branchId: "b-freq0" });
    const row = getByTestId("story-plan-auto-check-row");
    expect(row).not.toBeNull();
    const switchControl = getByRole("switch");
    expect(switchControl.getAttribute("aria-checked")).toBe("false");
    mocks.applyStoryPlanProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }), plan: APPLIED_PLAN });

    // Toggle ON → the apply body carries enableAutoCheck: true.
    fireEvent.click(switchControl);
    expect(switchControl.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(getByTestId("story-plan-proposal-accept"));
    await waitFor(() => expect(mocks.applyStoryPlanProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyStoryPlanProposal).toHaveBeenCalledWith("thread-1", "tc-plan", { enableAutoCheck: true });
    await waitFor(() => expect(queryByTestId("story-plan-proposal-accept")).toBeNull());
  });

  it("A6: leaving the toggle off sends an empty apply body (frequency untouched)", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-freq0-off" });
    mocks.applyStoryPlanProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }), plan: APPLIED_PLAN });
    fireEvent.click(getByTestId("story-plan-proposal-accept"));
    await waitFor(() => expect(mocks.applyStoryPlanProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyStoryPlanProposal).toHaveBeenCalledWith("thread-1", "tc-plan", {});
  });

  it("resolved statuses render the §6 lines with no review block (reload survives)", async () => {
    const applied = render(
      <StoryPlanProposalCard proposal={proposal({ status: "applied" })} threadId="thread-1" />,
    );
    expect(applied.getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("applied");
    expect(applied.getByTestId("story-plan-proposal-status").textContent).toBe(
      "agent.story_plan_proposal.status_applied",
    );
    expect(applied.getByTestId("story-plan-applied-line").textContent).toBe(
      "agent.story_plan_proposal.applied_line",
    );
    expect(applied.queryByTestId("story-plan-proposal-events")).toBeNull();
    expect(applied.queryByTestId("story-plan-proposal-accept")).toBeNull();
    applied.unmount();

    const rejected = render(
      <StoryPlanProposalCard proposal={proposal({ status: "rejected" })} threadId="thread-1" />,
    );
    expect(rejected.getByTestId("story-plan-proposal-status").textContent).toBe(
      "agent.story_plan_proposal.status_rejected",
    );
    expect(rejected.getByTestId("story-plan-rejected-line").textContent).toBe(
      "agent.story_plan_proposal.rejected_line",
    );
    expect(rejected.queryByTestId("story-plan-proposal-reject")).toBeNull();
  });

  it("Accept ingests the companion plan into the useAgentPlan cache (no second GET) and refetches the chat", async () => {
    // Seed BEFORE the hook mounts: its lazy GET must serve the stored plan.
    storedPlansByBranch.set("b-ingest", planOf(STORED_TASKS));
    seedChat({ branchId: "b-ingest" });
    const hook = renderHook(() => useAgentPlan({ kind: "chatBranch", chatId: "c1", branchId: "b-ingest" }));
    const { getByTestId } = await mountCard({ branchId: "b-ingest" });
    await waitFor(() => expect(hook.result.current.plan.tasks).toHaveLength(5));
    const getsBefore = fetchCalls.length;
    mocks.applyStoryPlanProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }), plan: APPLIED_PLAN });
    mocks.fetchChatAction.mockResolvedValue(undefined);

    fireEvent.click(getByTestId("story-plan-proposal-accept"));

    await waitFor(() => expect(mocks.fetchChatAction).toHaveBeenCalledTimes(1));
    expect(mocks.fetchChatAction).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(hook.result.current.plan.tasks).toHaveLength(3));
    expect(fetchCalls.length).toBe(getsBefore);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Reject resolves rejected without touching the chat or the plan cache", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-reject" });
    mocks.rejectStoryPlanProposal.mockResolvedValue({ proposal: proposal({ status: "rejected" }) });

    fireEvent.click(getByTestId("story-plan-proposal-reject"));

    await waitFor(() => expect(mocks.rejectStoryPlanProposal).toHaveBeenCalledTimes(1));
    expect(mocks.rejectStoryPlanProposal).toHaveBeenCalledWith("thread-1", "tc-plan");
    await waitFor(() =>
      expect(getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.applyStoryPlanProposal).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Accept/Reject/409 notify the host's live feed (onResolved) — the remount-resurrection guard", async () => {
    // The 2026-11 incident: after accepting, every chat re-entry re-offered
    // the proposal. The card resolved its LOCAL state only; the live turn
    // store kept the pending payload and its copy shadows the refetched
    // history on remount (AgentMessageList dedupes by toolCallId, live
    // wins). onResolved is the handover: the host patches the live store to
    // the server's final row, so the remounted card renders resolved.
    const onResolved = mock();
    const { getByTestId } = await mountCard({ branchId: "b-live", onResolved });
    mocks.applyStoryPlanProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }), plan: APPLIED_PLAN });

    fireEvent.click(getByTestId("story-plan-proposal-accept"));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith(proposal({ status: "applied" }));

    // The typed 409 (another tab resolved it first) ALSO notifies — our live
    // copy is stale in that scenario too.
    onResolved.mockClear();
    const second = await mountCard({ branchId: "b-live-409", onResolved });
    mocks.applyStoryPlanProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This objective proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );
    fireEvent.click(second.getByTestId("story-plan-proposal-accept"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith(proposal({ targetId: "b-live-409", status: "rejected" }));
  });

  it("409 already-resolved shows the server's final status", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-409" });
    mocks.applyStoryPlanProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This objective proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );

    fireEvent.click(getByTestId("story-plan-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("any other failure keeps the card pending and toasts", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-fail" });
    mocks.applyStoryPlanProposal.mockRejectedValue(new Error("boom"));

    fireEvent.click(getByTestId("story-plan-proposal-accept"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("boom");
    expect(getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("story-plan-proposal-accept").getAttribute("disabled")).toBeNull();
  });

  it("both buttons disable while the request runs", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-busy" });
    let resolveApply!: (value: { proposal: RecordProposal; plan: AgentPlan }) => void;
    mocks.applyStoryPlanProposal.mockReturnValue(
      new Promise<{ proposal: RecordProposal; plan: AgentPlan }>((resolve) => {
        resolveApply = resolve;
      }),
    );

    fireEvent.click(getByTestId("story-plan-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("story-plan-proposal-reject").getAttribute("disabled")).not.toBeNull(),
    );
    expect(getByTestId("story-plan-proposal-accept").getAttribute("disabled")).not.toBeNull();
    resolveApply({ proposal: proposal({ status: "applied" }), plan: APPLIED_PLAN });
    await waitFor(() =>
      expect(getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
  });

  it("unshaped payload renders the header without a throw and no review block", () => {
    seedChat({ branchId: "b1" });
    let view: ReturnType<typeof render> | null = null;
    expect(() => {
      view = render(<StoryPlanProposalCard proposal={proposal({ payload: null })} threadId="thread-1" />);
    }).not.toThrow();
    expect(view!.getByTestId("story-plan-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(view!.queryByTestId("story-plan-proposal-summary")).toBeNull();
    expect(view!.queryByTestId("story-plan-proposal-accept")).toBeNull();
  });

  it("locale tables carry the card strings (RU canon from mock §1/§6, byte-exact)", () => {
    const record = en as Record<string, string>;
    expect(record["agent.story_plan_proposal.title"]).toBe("Story plan");
    expect(record["agent.story_plan_proposal.status_pending"]).toBe("awaiting decision");
    expect(record["agent.story_plan_proposal.status_applied"]).toBe("accepted");
    expect(record["agent.story_plan_proposal.status_rejected"]).toBe("rejected");
    expect(record["agent.story_plan_proposal.applied_line"]).toBe(
      "Plan updated — the current event was handed to the goal tracker.",
    );
    expect(record["agent.story_plan_proposal.rejected_line"]).toBe("Proposal rejected, the plan is unchanged.");
    expect(record["agent.story_plan_proposal.marker_new"]).toBe("new");
    expect(record["agent.story_plan_proposal.marker_changed"]).toBe("changed");
    expect(record["agent.story_plan_proposal.marker_removed"]).toBe("removed");
    expect(record["agent.story_plan_proposal.warning_replace_goals"]).toBe(
      "Goal tracker goals will be replaced by the plan's events",
    );
    expect(record["agent.story_plan_proposal.auto_check_label"]).toBe("Check completion after each reply");
    // DK-10: the dated rows' time chip — the ONE derivation the events tab
    // renders too, so its labels are card strings as well.
    expect(record["story_event_at_day"]).toBe("day {day}");
    expect(record["story_event_at_day_part"]).toBe("day {day} · {part}");
    expect(record["story_event_awaits_time"]).toBe("awaits its time");

    const ruRecord = ru as Record<string, string>;
    expect(ruRecord["agent.story_plan_proposal.title"]).toBe("План сюжета");
    expect(ruRecord["agent.story_plan_proposal.status_pending"]).toBe("ждёт решения");
    expect(ruRecord["agent.story_plan_proposal.status_applied"]).toBe("принято");
    expect(ruRecord["agent.story_plan_proposal.status_rejected"]).toBe("отклонено");
    expect(ruRecord["agent.story_plan_proposal.applied_line"]).toBe(
      "План обновлён — текущее событие передано трекеру целей.",
    );
    expect(ruRecord["agent.story_plan_proposal.rejected_line"]).toBe("Предложение отклонено, план не изменился.");
    expect(ruRecord["agent.story_plan_proposal.marker_new"]).toBe("новое");
    expect(ruRecord["agent.story_plan_proposal.marker_changed"]).toBe("изменено");
    expect(ruRecord["agent.story_plan_proposal.marker_removed"]).toBe("убрано");
    expect(ruRecord["agent.story_plan_proposal.warning_replace_goals"]).toBe(
      "Цели в трекере целей заменятся событиями плана",
    );
    expect(ruRecord["agent.story_plan_proposal.auto_check_label"]).toBe(
      "Проверять выполнение после каждого ответа",
    );
    expect(ruRecord["story_event_at_day"]).toBe("день {day}");
    expect(ruRecord["story_event_at_day_part"]).toBe("день {day} · {part}");
    expect(ruRecord["story_event_awaits_time"]).toBe("ждёт своего часа");
  });

  it("pins the propose_plan tool label (the profile modal's sidechat toggle)", async () => {
    const { SIDECHAT_PROFILE_TOOL_LABEL_KEYS } = await import(
      "../../shared/agent-shell/agent-tool-labels.js"
    );
    expect(SIDECHAT_PROFILE_TOOL_LABEL_KEYS.propose_plan).toBe("agent_tool_propose_plan");
    const record = en as Record<string, string>;
    const ruRecord = ru as Record<string, string>;
    expect(record["agent_tool_propose_plan"]).toBe("Propose a story plan");
    expect(ruRecord["agent_tool_propose_plan"]).toBe("Предлагать план сюжета");
  });
});

// ─── DK-10 (mockup §6): the dated event's muted time chip ───────────────────
// Payload-only: the card reads NO clock, so a dated proposed row carries the
// chip (the ONE storyEventTimeLabel derivation) and nothing ever carries the
// "awaits its time" mark here. Key-echo i18n: the part-bearing chip echoes
// story_event_at_day_part, the partless one story_event_at_day — the two
// shapes are distinguishable without a locale.
describe("StoryPlanProposalCard — the time chip (DK-10, mockup §6)", () => {
  it("a dated proposed event carries the chip; a partless at renders the day-only label; undated carries none", async () => {
    const branchId = "b1-chip";
    const proposed: AgentPlanTask[] = [
      { id: "d1", title: "Vet visit", body: "", status: "pending", at: { day: 4, part: "evening" } },
      { id: "d2", title: "Undated task", body: "", status: "pending" },
      { id: "d3", title: "Day-only task", body: "", status: "pending", at: { day: 2, part: null } },
    ];
    storedPlansByBranch.set(branchId, planOf([]));
    seedChat({ branchId });
    const view = render(
      <StoryPlanProposalCard
        proposal={proposal({ targetId: branchId, payload: { plan: planOf(proposed) } })}
        threadId="thread-1"
      />,
    );
    await waitFor(() => expect(view.getByTestId("story-plan-proposal-events")).not.toBeNull());
    const chips = view.getAllByTestId("story-plan-event-time");
    expect(chips).toHaveLength(2);
    // Row order = the proposed order: the part-bearing chip first, the
    // day-only chip on the third row.
    expect(chips[0]!.textContent).toBe("story_event_at_day_part");
    expect(chips[1]!.textContent).toBe("story_event_at_day");
    // No wait mark exists in the card at all (payload-only).
    expect(view.queryByText("story_event_awaits_time")).toBeNull();
  });
});
