/**
 * StoryDeckProposalCard — DIRECTOR_DECK_CALENDAR_PLAN DK-8 (mockup §4).
 *
 * Pins the card's own contract: the proposed-cards fan (one `StoryCardFace
 * size="sm"` per payload card, suits through the shared face; desktop wrap +
 * phone horizontal scroll pinned as class strings — happy-dom applies no
 * CSS); the model summary; the reused chip/title/reject copy; Accept calls
 * the SC-13c accept route AND re-runs the branch's deck GET through the
 * `refreshStoryDeck` cache seam (the curtain's deck tab learns the cards —
 * asserted at the fetch level through the real use-story-deck hook); no
 * chat refetch on Accept (D2); Reject resolves without touching the deck;
 * the resolved states render mock §4's two lines and survive a reload
 * (remount against the same served record); the typed already-resolved 409;
 * other failures toast and keep the card pending; buttons disable while a
 * request runs; an unshaped payload renders empty without a throw; the
 * locale tables carry the RU canon (mock §4, byte-exact) and the
 * `propose_deck` tool label is pinned.
 *
 * Test-hygiene L1: (1) paths repo-relative / `${import.meta.dir}`-free —
 * relative imports only, no path literals; (2) restores: `globalThis.fetch`
 * restored in afterEach + afterAll (R3), no registry resets, the i18n seam
 * is the shared identity-echo stub (no real i18n init); (3) waits are
 * resolved-state assertions (`waitFor` on the deck cache / status rows), no
 * sleeps; (4) no OS assumptions; (5) `mock.module` only with the `...real`
 * spread; per-test BRANCH ids keep the module-global deck cache entries
 * disjoint; (6) assertions pin resolved states (data-status, deck contents
 * after the refresh GET lands); (7) no DB, no heavy setup — happy-dom via
 * the shared dom-env.
 *
 * Runner: bun:test + happy-dom. The snapshot store is exercised for real
 * (seeded/reset per test); `useT`, the proposals API, sonner, and
 * `globalThis.fetch` (the deck GET through the real use-story-deck seam —
 * the StoryDeckView.test.tsx router) are mocked. Per-test branch ids keep
 * the deck cache entries disjoint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import { brandId, normalizeInsightsConfig, normalizeObjectiveState, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireChat } from "../../../../test/wire-fixtures.js";
import type { RecordProposal, StoryCard, StoryDeck } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { fireEvent, render, renderHook, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useStoryDeck } from "../../../hooks/use-story-deck.js";

const mocks = {
  applyObjectiveProposal: mock(),
  rejectObjectiveProposal: mock(),
  toastError: mock(),
};
const realProposalsApi = await import("../../../api/agent-thread-proposals-api.js");
const realSonner = await import("sonner");

installI18nContextSeam();

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: mocks.toastError },
}));

mock.module("../../../api/agent-thread-proposals-api.js", () => ({
  ...realProposalsApi,
  applyObjectiveProposal: mocks.applyObjectiveProposal,
  rejectObjectiveProposal: mocks.rejectObjectiveProposal,
}));

let StoryDeckProposalCard: typeof import("./StoryDeckProposalCard.js").StoryDeckProposalCard;
let STORY_DECK_RECORD_TYPE: typeof import("./StoryDeckProposalCard.js").STORY_DECK_RECORD_TYPE;
beforeAll(async () => {
  ({ StoryDeckProposalCard, STORY_DECK_RECORD_TYPE } = await import("./StoryDeckProposalCard.js"));
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The mock §4 proposal: five compact faces across every suit. */
const CARDS: StoryCard[] = [
  { id: "p1", suit: "threat", title: "Vet visit", body: "The neighbor already rings the doorbell." },
  { id: "p2", suit: "encounter", title: "The former owner", body: "A woman puts up lost-cat posters." },
  { id: "p3", suit: "discovery", title: "A collar with an address", body: "Engraved with another city." },
  { id: "p4", suit: "mystery", title: "Purring at 3 a.m.", body: "For a moment he is a cat again." },
  { id: "p5", suit: "change", title: "Storm and darkness", body: "The power dies; Archie sees in the dark." },
];

const EMPTY_DECK: StoryDeck = { cards: [] };

/** The deck each branch GET serves, keyed by the per-test branch id. */
const decksByBranch = new Map<string, StoryDeck>();
/** Deck GETs served per branch — the refresh seam's re-run counter. */
const deckGets = new Map<string, number>();

const originalFetch = globalThis.fetch;
beforeEach(() => {
  decksByBranch.clear();
  deckGets.clear();
  globalThis.fetch = testFetch(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/deck")) {
      const branchId = url.split("/branches/")[1]?.split("/")[0] ?? "";
      deckGets.set(branchId, (deckGets.get(branchId) ?? 0) + 1);
      return new Response(JSON.stringify({ deck: decksByBranch.get(branchId) ?? EMPTY_DECK }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  mocks.applyObjectiveProposal.mockReset();
  mocks.rejectObjectiveProposal.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  useSnapshotStore.setState({ activeChat: null });
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Seed the ACTIVE chat the card reads its ids from (the sibling cards'
 *  seed pattern: the wire factory through `ingestSnapshot`; the objective
 *  state rides the domain's persisted-column seam). */
function seedChat(branchId: string): void {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: wireChat({
      id: brandId<ChatId>("c1"),
      activeBranchId: brandId<ChatBranchId>(branchId),
      insightsConfig: normalizeInsightsConfig({ objectiveEnabled: true, trackerEnabled: false }),
      insightsObjectiveState: normalizeObjectiveState({
        mode: "goals",
        objectiveDescription: "",
        tasks: [],
        longTermGoal: null,
        shortTermGoals: [],
        autoCheckFrequency: 0,
        autoCheckEventCount: 0,
        contextWindow: 6,
        injectionDepth: 1,
        generatePrompt: "",
        checkPrompt: "",
        injectPrompt: "",
      }),
    }),
  });
}

function proposal(over: Partial<RecordProposal> & { payload?: unknown }): RecordProposal {
  return {
    kind: "record",
    id: "tc-deck",
    recordType: STORY_DECK_RECORD_TYPE,
    op: "update",
    targetId: "b1",
    payload: {
      cards: CARDS,
      summary: "Five twists for the cozy comedy; none closes the story.",
    },
    status: "pending",
    ...over,
  };
}

/** Mount a pending card with the active chat seeded and wait for the fan. */
async function mountCard(over?: {
  branchId?: string;
  proposal?: RecordProposal;
  onResolved?: (proposal: RecordProposal) => void;
}) {
  const branchId = over?.branchId ?? "b1";
  seedChat(branchId);
  return render(
    <StoryDeckProposalCard
      proposal={over?.proposal ?? proposal({ targetId: branchId })}
      threadId="thread-1"
      {...(over?.onResolved !== undefined ? { onResolved: over.onResolved } : {})}
    />,
  );
}

// ─── The card ───────────────────────────────────────────────────────────────

describe("StoryDeckProposalCard (DK-8)", () => {
  it("renders the fan: a compact face per proposed card, summary, pending chip (mock §4)", async () => {
    const { getByTestId, getAllByTestId } = await mountCard({ branchId: "b-fan" });
    const faces = getAllByTestId("story-card");
    expect(faces).toHaveLength(5);
    expect(faces.map((face) => face.getAttribute("data-suit"))).toEqual([
      "threat",
      "encounter",
      "discovery",
      "mystery",
      "change",
    ]);
    expect(getByTestId("story-deck-proposal-summary").textContent).toBe(
      "Five twists for the cozy comedy; none closes the story.",
    );
    expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("story-deck-proposal-card").getAttribute("data-record-type")).toBe("story-deck");
    expect(getByTestId("story-deck-proposal-status").textContent).toBe(
      "agent.story_plan_proposal.status_pending",
    );
    expect(getByTestId("story-deck-proposal-accept").getAttribute("disabled")).toBeNull();
    // Mock §4's dual-mode fan, pinned as class strings (happy-dom applies no
    // CSS): desktop wraps, the phone scrolls horizontally.
    const fan = getByTestId("story-deck-proposal-fan");
    expect(fan.className).toContain("flex-wrap");
    expect(fan.className).toContain("max-md:flex-nowrap");
    expect(fan.className).toContain("max-md:overflow-x-auto");
  });

  it("Accept calls the accept route AND re-runs the branch's deck GET (the refreshStoryDeck seam)", async () => {
    // Seed BEFORE the hook mounts: its lazy GET must serve the stored deck.
    decksByBranch.set("b-accept", { cards: [CARDS[0]!, CARDS[1]!] });
    seedChat("b-accept");
    const hook = renderHook(() => useStoryDeck("c1", "b-accept"));
    await waitFor(() => expect(hook.result.current.deck.cards).toHaveLength(2));
    const getsBefore = deckGets.get("b-accept") ?? 0;
    // The refreshed GET will serve the deck WITH the accepted cards.
    decksByBranch.set("b-accept", { cards: [...CARDS] });
    mocks.applyObjectiveProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }) });
    const { getByTestId } = await mountCard({
      branchId: "b-accept",
      proposal: proposal({ targetId: "b-accept" }),
    });

    fireEvent.click(getByTestId("story-deck-proposal-accept"));

    await waitFor(() => expect(mocks.applyObjectiveProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyObjectiveProposal).toHaveBeenCalledWith("thread-1", "tc-deck");
    // The deck GET re-ran through the SAME cache entry and its result landed:
    // the hook (the curtain's tab's seam) now sees the accepted cards.
    await waitFor(() => expect(hook.result.current.deck.cards).toHaveLength(5));
    expect(deckGets.get("b-accept")).toBe(getsBefore + 1);
    await waitFor(() =>
      expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(getByTestId("story-deck-applied-line").textContent).toBe(
      "agent.story_deck_proposal.applied_line",
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Reject resolves rejected without touching the deck or the proposals-apply arm", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-reject" });
    mocks.rejectObjectiveProposal.mockResolvedValue({ proposal: proposal({ status: "rejected" }) });

    // No deck GET ran at mount (the card renders the payload, not the deck).
    expect((deckGets.get("b-reject") ?? 0)).toBe(0);

    fireEvent.click(getByTestId("story-deck-proposal-reject"));

    await waitFor(() => expect(mocks.rejectObjectiveProposal).toHaveBeenCalledTimes(1));
    expect(mocks.rejectObjectiveProposal).toHaveBeenCalledWith("thread-1", "tc-deck");
    await waitFor(() =>
      expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("story-deck-rejected-line").textContent).toBe(
      "agent.story_deck_proposal.rejected_line",
    );
    expect((deckGets.get("b-reject") ?? 0)).toBe(0);
    expect(mocks.applyObjectiveProposal).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("resolved statuses render the §4 lines with no fan and no buttons, and survive a reload", async () => {
    const mount = (status: RecordProposal["status"]) =>
      render(<StoryDeckProposalCard proposal={proposal({ status })} threadId="thread-1" />);

    const applied = mount("applied");
    expect(applied.getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("applied");
    expect(applied.getByTestId("story-deck-proposal-status").textContent).toBe(
      "agent.story_plan_proposal.status_applied",
    );
    expect(applied.getByTestId("story-deck-applied-line").textContent).toBe(
      "agent.story_deck_proposal.applied_line",
    );
    // D3: the resolved card renders header + line only (mock §4).
    expect(applied.queryByTestId("story-deck-proposal-fan")).toBeNull();
    expect(applied.queryByTestId("story-deck-proposal-summary")).toBeNull();
    expect(applied.queryByTestId("story-deck-proposal-accept")).toBeNull();
    // Reload: unmount + remount against the SAME served record — line again.
    applied.unmount();
    const appliedReload = mount("applied");
    expect(appliedReload.getByTestId("story-deck-applied-line")).not.toBeNull();
    appliedReload.unmount();

    const rejected = mount("rejected");
    expect(rejected.getByTestId("story-deck-proposal-status").textContent).toBe(
      "agent.story_plan_proposal.status_rejected",
    );
    expect(rejected.getByTestId("story-deck-rejected-line").textContent).toBe(
      "agent.story_deck_proposal.rejected_line",
    );
    expect(rejected.queryByTestId("story-deck-proposal-fan")).toBeNull();
    expect(rejected.queryByTestId("story-deck-proposal-reject")).toBeNull();
    rejected.unmount();
    const rejectedReload = mount("rejected");
    expect(rejectedReload.getByTestId("story-deck-rejected-line")).not.toBeNull();
  });

  it("Accept/Reject/409 notify the host's live feed (onResolved) — the remount-resurrection guard", async () => {
    const onResolved = mock();
    const { getByTestId } = await mountCard({ branchId: "b-live", onResolved });
    mocks.applyObjectiveProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }) });

    fireEvent.click(getByTestId("story-deck-proposal-accept"));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith(proposal({ status: "applied" }));

    // The typed 409 (another tab resolved it first) ALSO notifies.
    onResolved.mockClear();
    const second = await mountCard({ branchId: "b-live-409", onResolved });
    mocks.applyObjectiveProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );
    fireEvent.click(second.getByTestId("story-deck-proposal-accept"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith(proposal({ targetId: "b-live-409", status: "rejected" }));
  });

  it("409 already-resolved shows the server's final status", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-409" });
    mocks.applyObjectiveProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );

    fireEvent.click(getByTestId("story-deck-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("story-deck-rejected-line")).not.toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("any other failure keeps the card pending and toasts", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-fail" });
    mocks.applyObjectiveProposal.mockRejectedValue(new Error("boom"));

    fireEvent.click(getByTestId("story-deck-proposal-accept"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("boom");
    expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("story-deck-proposal-accept").getAttribute("disabled")).toBeNull();
  });

  it("both buttons disable while the request runs", async () => {
    const { getByTestId } = await mountCard({ branchId: "b-busy" });
    let resolveApply!: (value: { proposal: RecordProposal }) => void;
    mocks.applyObjectiveProposal.mockReturnValue(
      new Promise<{ proposal: RecordProposal }>((resolve) => {
        resolveApply = resolve;
      }),
    );

    fireEvent.click(getByTestId("story-deck-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("story-deck-proposal-reject").getAttribute("disabled")).not.toBeNull(),
    );
    expect(getByTestId("story-deck-proposal-accept").getAttribute("disabled")).not.toBeNull();
    resolveApply({ proposal: proposal({ status: "applied" }) });
    await waitFor(() =>
      expect(getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
  });

  it("unshaped payload renders the header without a throw and no review block", () => {
    seedChat("b1");
    let view: ReturnType<typeof render> | null = null;
    expect(() => {
      view = render(<StoryDeckProposalCard proposal={proposal({ payload: null })} threadId="thread-1" />);
    }).not.toThrow();
    expect(view!.getByTestId("story-deck-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(view!.queryByTestId("story-deck-proposal-summary")).toBeNull();
    expect(view!.queryByTestId("story-deck-proposal-fan")).toBeNull();
    expect(view!.queryByTestId("story-deck-proposal-accept")).toBeNull();
  });

  it("locale tables carry the card strings (RU canon from mock §4, byte-exact)", () => {
    const record = en as Record<string, string>;
    expect(record["agent.story_deck_proposal.accept"]).toBe("Add to deck");
    expect(record["agent.story_deck_proposal.applied_line"]).toBe(
      "Cards added to the deck — play them from the plan curtain.",
    );
    expect(record["agent.story_deck_proposal.rejected_line"]).toBe(
      "Proposal rejected, the deck is unchanged.",
    );

    const ruRecord = ru as Record<string, string>;
    expect(ruRecord["agent.story_deck_proposal.accept"]).toBe("Добавить в колоду");
    expect(ruRecord["agent.story_deck_proposal.applied_line"]).toBe(
      "Карты добавлены в колоду — разыграть их можно в шторке плана.",
    );
    expect(ruRecord["agent.story_deck_proposal.rejected_line"]).toBe(
      "Предложение отклонено, колода не изменилась.",
    );
  });

  it("pins the propose_deck tool label (the profile modal's sidechat toggle)", async () => {
    const { SIDECHAT_PROFILE_TOOL_LABEL_KEYS } = await import(
      "../../shared/agent-shell/agent-tool-labels.js"
    );
    expect(SIDECHAT_PROFILE_TOOL_LABEL_KEYS.propose_deck).toBe("agent_tool_propose_deck");
    const record = en as Record<string, string>;
    const ruRecord = ru as Record<string, string>;
    expect(record["agent_tool_propose_deck"]).toBe("Propose a twist deck");
    expect(ruRecord["agent_tool_propose_deck"]).toBe("Предлагать колоду поворотов");
  });
});
