/**
 * ObjectiveProposalCard — SC-13c.
 *
 * Pins the card's own contract: the four states (pending with tracker on /
 * off, stored applied, stored rejected); Accept calls apply once with the
 * (threadId, toolCallId) pair and refetches the active chat; both typed 409s
 * land in the right state (disabled → the off state, already-resolved → the
 * server's final status); any other failure keeps the card pending and
 * toasts; both buttons disable while a request runs; an unshaped payload
 * renders empty without throwing.
 *
 * Runner: bun:test + happy-dom. The snapshot store is exercised for real
 * (seeded/reset per test); `useT`, the proposals API, `fetchChatAction`, and
 * the sonner toast are mocked (the objective-zone.test.tsx precedent).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import type { AppSnapshot } from "../../../api/types.js";

const mocks = {
  applyObjectiveProposal: mock(),
  rejectObjectiveProposal: mock(),
  fetchChatAction: mock(),
  toastError: mock(),
};
const realI18nContext = await import("../../../i18n/context.js");
const realProposalsApi = await import("../../../api/agent-thread-proposals-api.js");
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
const realSonner = await import("sonner");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: mocks.toastError },
}));

mock.module("../../../api/agent-thread-proposals-api.js", () => ({
  ...realProposalsApi,
  applyObjectiveProposal: mocks.applyObjectiveProposal,
  rejectObjectiveProposal: mocks.rejectObjectiveProposal,
}));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  fetchChatAction: mocks.fetchChatAction,
}));

let ObjectiveProposalCard: typeof import("./ObjectiveProposalCard.js").ObjectiveProposalCard;
beforeAll(async () => {
  ({ ObjectiveProposalCard } = await import("./ObjectiveProposalCard.js"));
});

function proposal(over: Partial<RecordProposal>): RecordProposal {
  return {
    kind: "record",
    id: "tc-prop",
    recordType: "objective",
    op: "create",
    payload: { description: "Cross the ravine before dawn", reason: "The bridge burns at midnight" },
    status: "pending",
    ...over,
  };
}

/** Seed the ACTIVE chat the card reads its tracker toggle from (the
 *  ImageGenMessageMenu seed pattern: minimal wire double through
 *  `ingestSnapshot`, so the hygiene cast budget stays flat). */
function seedChat(objectiveEnabled: boolean) {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: { id: "c1", insightsConfig: { objectiveEnabled, trackerEnabled: false } },
  } as unknown as AppSnapshot);
}

beforeEach(() => {
  seedChat(true);
  mocks.applyObjectiveProposal.mockReset();
  mocks.rejectObjectiveProposal.mockReset();
  mocks.fetchChatAction.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  useSnapshotStore.setState({ activeChat: null });
});

describe("ObjectiveProposalCard (SC-13c)", () => {
  it("pending with the tracker on: description + reason render, both buttons enabled, no hint", () => {
    const { getByTestId, queryByTestId } = render(
      <ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />,
    );
    const card = getByTestId("objective-proposal-card");
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(getByTestId("objective-proposal-description").textContent).toBe("Cross the ravine before dawn");
    expect(getByTestId("objective-proposal-reason").textContent).toBe("The bridge burns at midnight");
    expect(getByTestId("objective-proposal-accept").getAttribute("disabled")).toBeNull();
    expect(getByTestId("objective-proposal-reject").getAttribute("disabled")).toBeNull();
    expect(queryByTestId("objective-proposal-tracker-hint")).toBeNull();
  });

  it("pending with the tracker off: Accept disabled with the hint, Reject stays enabled (D2)", () => {
    seedChat(false);
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);
    expect(getByTestId("objective-proposal-accept").getAttribute("disabled")).not.toBeNull();
    expect(getByTestId("objective-proposal-tracker-hint").textContent).toBe(
      "agent.objective_proposal.tracker_disabled_hint",
    );
    // Reject writes nothing to the tracker — it is NOT gated by the toggle.
    expect(getByTestId("objective-proposal-reject").getAttribute("disabled")).toBeNull();
    expect(mocks.applyObjectiveProposal).not.toHaveBeenCalled();
  });

  it("stored applied status (reloaded thread): the added line, no buttons", () => {
    const { getByTestId, queryByTestId } = render(
      <ObjectiveProposalCard proposal={proposal({ status: "applied" })} threadId="thread-1" />,
    );
    expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("applied");
    expect(getByTestId("objective-proposal-status").textContent).toBe("agent.objective_proposal.added");
    expect(getByTestId("objective-proposal-description").textContent).toBe("Cross the ravine before dawn");
    expect(queryByTestId("objective-proposal-accept")).toBeNull();
    expect(queryByTestId("objective-proposal-reject")).toBeNull();
  });

  it("stored rejected status (reloaded thread): the rejected line, no buttons", () => {
    const { getByTestId, queryByTestId } = render(
      <ObjectiveProposalCard proposal={proposal({ status: "rejected" })} threadId="thread-1" />,
    );
    expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("rejected");
    expect(getByTestId("objective-proposal-status").textContent).toBe("agent.objective_proposal.rejected");
    expect(queryByTestId("objective-proposal-accept")).toBeNull();
    expect(queryByTestId("objective-proposal-reject")).toBeNull();
  });

  it("Accept calls apply once with (threadId, toolCallId) and refetches the active chat", async () => {
    mocks.applyObjectiveProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }) });
    mocks.fetchChatAction.mockResolvedValue(undefined);
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-accept"));

    await waitFor(() => expect(mocks.applyObjectiveProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyObjectiveProposal).toHaveBeenCalledWith("thread-1", "tc-prop");
    await waitFor(() => expect(mocks.fetchChatAction).toHaveBeenCalledTimes(1));
    expect(mocks.fetchChatAction).toHaveBeenCalledWith("c1");
    await waitFor(() =>
      expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Reject resolves rejected without touching the chat", async () => {
    mocks.rejectObjectiveProposal.mockResolvedValue({ proposal: proposal({ status: "rejected" }) });
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-reject"));

    await waitFor(() => expect(mocks.rejectObjectiveProposal).toHaveBeenCalledTimes(1));
    expect(mocks.rejectObjectiveProposal).toHaveBeenCalledWith("thread-1", "tc-prop");
    await waitFor(() =>
      expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("409 objective_tracker_disabled pins the off state (still pending, no toast)", async () => {
    mocks.applyObjectiveProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "The Objective Tracker is disabled for this chat",
        realProposalsApi.OBJECTIVE_TRACKER_DISABLED_CODE,
      ),
    );
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-accept"));

    await waitFor(() => expect(getByTestId("objective-proposal-tracker-hint")).not.toBeNull());
    expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("objective-proposal-accept").getAttribute("disabled")).not.toBeNull();
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("409 objective_proposal_already_resolved shows the server's final status", async () => {
    mocks.applyObjectiveProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This objective proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("objective-proposal-status").textContent).toBe("agent.objective_proposal.rejected");
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("any other failure keeps the card pending and toasts", async () => {
    mocks.applyObjectiveProposal.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-accept"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("boom");
    expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("objective-proposal-accept").getAttribute("disabled")).toBeNull();
  });

  it("both buttons disable while the request runs (D3)", async () => {
    let resolveApply!: (v: { proposal: RecordProposal }) => void;
    mocks.applyObjectiveProposal.mockReturnValue(
      new Promise<{ proposal: RecordProposal }>((res) => {
        resolveApply = res;
      }),
    );
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("objective-proposal-accept"));

    await waitFor(() => expect(getByTestId("objective-proposal-reject").getAttribute("disabled")).not.toBeNull());
    expect(getByTestId("objective-proposal-accept").getAttribute("disabled")).not.toBeNull();
    resolveApply({ proposal: proposal({ status: "applied" }) });
    await waitFor(() =>
      expect(getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
  });

  it("absent reason renders no reason node", () => {
    const { queryByTestId } = render(
      <ObjectiveProposalCard proposal={proposal({ payload: { description: "Only text" } })} threadId="thread-1" />,
    );
    expect(queryByTestId("objective-proposal-reason")).toBeNull();
  });

  it("unshaped payload renders empty — no throw", () => {
    let card: ReturnType<typeof render> | null = null;
    expect(() => {
      card = render(<ObjectiveProposalCard proposal={proposal({ payload: null })} threadId="thread-1" />);
    }).not.toThrow();
    expect(card!.getByTestId("objective-proposal-description").textContent).toBe("");
    expect(card!.getByTestId("objective-proposal-card").getAttribute("data-status")).toBe("pending");
  });

  it("locale tables carry the new card strings (RU owner-specified, byte-exact)", () => {
    const record = en as Record<string, string>;
    expect(record["agent.objective_proposal.added"]).toBe("Added to tracker");
    expect(record["agent.objective_proposal.rejected"]).toBe("Rejected");
    expect(record["agent.objective_proposal.tracker_disabled_hint"]).toBe(
      "Objective tracker is disabled in the chat settings",
    );
    expect(record["agent.objective_proposal.request_failed"]).toBe("The objective proposal request failed");
    const ruRecord = ru as Record<string, string>;
    expect(ruRecord["agent.objective_proposal.added"]).toBe("Добавлено в трекер");
    expect(ruRecord["agent.objective_proposal.rejected"]).toBe("Отклонено");
    expect(ruRecord["agent.objective_proposal.tracker_disabled_hint"]).toBe(
      "Трекер целей выключен в настройках чата",
    );
    expect(ruRecord["agent.objective_proposal.request_failed"]).toBe("Не удалось выполнить запрос предложения");
  });
});

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The description + reason are MODEL text —
// they opt back in; the accept button (chrome) stays out.
describe("ObjectiveProposalCard — page translation (follow-up 2026-10-24)", () => {
  it("description + reason carry translate=yes, chrome accept button does not", () => {
    const { getByTestId } = render(<ObjectiveProposalCard proposal={proposal({})} threadId="thread-1" />);
    expect(getByTestId("objective-proposal-description").getAttribute("translate")).toBe("yes");
    expect(getByTestId("objective-proposal-reason").getAttribute("translate")).toBe("yes");
    expect(getByTestId("objective-proposal-accept").getAttribute("translate")).toBeNull();
  });
});
