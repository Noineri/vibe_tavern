/**
 * DirectorMessageProposalCard — DIRECTOR_MESSAGE_TOOLS_PLAN Wave 3 / DMT-33.
 *
 * Pins the ONE card's contract for BOTH record types:
 *   - `message-edit`: the pending review renders the editor's diff (the word
 *     diff labels) + the FULL candidate preview (never truncated) + the
 *     instruction, and Apply calls the apply route once with
 *     (threadId, toolCallId) and hands the response's TARGET-SCOPED message
 *     companion to the canonical ingest action;
 *   - `message-variant`: the Director's COMPLETE new reply is the candidate,
 *     a SINGLE source renders an ENABLED Save (never the merge tool's
 *     two-source minimum), no diff block, Save applies through the same pair;
 *   - Reject resolves rejected with no ingestion and no chat writes;
 *   - duplicate clicks resolve once (the busy guard), and a running request
 *     disables both buttons;
 *   - a non-already-resolved 409 pins the conflict line with the primary
 *     disabled (still pending — the server kept the row), a 404 pins the
 *     missing line, the typed already-resolved 409 shows the server's final
 *     status and fires onResolved, any other failure toasts and stays pending;
 *   - the persisted status seeds the card (a reloaded thread renders
 *     applied/rejected with no fetch);
 *   - rendering makes NO call before the user acts;
 *   - an unshaped payload renders the frame empty, never a throw;
 *   - the canonical ingest action itself (`ingestMessageCompanionAction`,
 *     the REAL one): merges the companion into exactly its named message —
 *     preserving the surviving variants' narrowed-away fields, completing a
 *     NEW variant the way the server DTO builds one, mirroring the selected
 *     variant — and no-ops when the open conversation differs or the message
 *     is not loaded (never an unscoped snapshot).
 *
 * Runner: bun:test + happy-dom. The snapshot store is exercised for real
 * (seeded/reset per test); `useT` runs through the shared i18n seam (raw-key
 * echo, the three target/count keys interpolated from the bundled EN
 * templates); the proposals API, the ingest action (spy — the action itself
 * is unit-pinned below against the real store) and the sonner toast are
 * mocked (the ObjectiveProposalCard.test.tsx precedent).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireBranch, wireChat } from "../../../../test/wire-fixtures.js";
import { DIRECTOR_MESSAGE_RECORD_TYPES, type RecordProposal } from "@vibe-tavern/api-contracts";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import type { AppMessage } from "../../../api/types.js";
import type { SidechatProposalMessageCompanion } from "../../../api/agent-thread-proposals-api.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

installI18nContextSeam({
  interpolateKeys: [
    "agent.message_edit_proposal.target_line",
    "agent.message_variant_proposal.target_line",
    "agent.message_variant_proposal.sources_label",
  ],
});

const mocks = {
  applyDirectorMessageProposal: mock(),
  rejectDirectorMessageProposal: mock(),
  ingestMessageCompanionAction: mock(),
  toastError: mock(),
};
const realProposalsApi = await import("../../../api/agent-thread-proposals-api.js");
// R15 load-time copy: the REAL module namespace (the action unit tests below
// call `realChatActions.ingestMessageCompanionAction` against the real store,
// immune to the registration above).
const realChatActions = { ...(await import("../../../stores/api-actions/chat-actions.js")) };
const realSonner = await import("sonner");

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: mocks.toastError },
}));

mock.module("../../../api/agent-thread-proposals-api.js", () => ({
  ...realProposalsApi,
  applyDirectorMessageProposal: mocks.applyDirectorMessageProposal,
  rejectDirectorMessageProposal: mocks.rejectDirectorMessageProposal,
}));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  ingestMessageCompanionAction: mocks.ingestMessageCompanionAction,
}));

let DirectorMessageProposalCard: typeof import("./director-message-proposal-card.js").DirectorMessageProposalCard;
beforeAll(async () => {
  ({ DirectorMessageProposalCard } = await import("./director-message-proposal-card.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const EDIT_PAYLOAD = {
  source: { messageId: "m1", variantId: "v1", position: 3, variantNumber: 1 },
  sourceText: "She opened the door slowly.",
  instruction: "Fix the pose — she is sitting, not standing.",
  candidate: "She sat by the opened door slowly, exactly as staged.",
  editor: { modelId: "editor-model", finishReason: "stop" },
};

/** Long, multi-line candidate — the full text must survive into the preview
 *  (the card never truncates authored/model copy; the preview scrolls). */
const FULL_CANDIDATE = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1}: she counts the hours between the streetlights and pretends the city is asleep around her.`,
).join("\n");

const VARIANT_PAYLOAD = {
  sources: [{ messageId: "m1", variantId: "v1", position: 3, variantNumber: 2 }],
  content: FULL_CANDIDATE,
};

function editProposal(over: Partial<RecordProposal>): RecordProposal {
  return {
    kind: "record",
    id: "tc-prop",
    recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
    op: "update",
    targetId: "m1",
    payload: EDIT_PAYLOAD,
    status: "pending",
    ...over,
  };
}

function variantProposal(over: Partial<RecordProposal>): RecordProposal {
  return {
    kind: "record",
    id: "tc-prop",
    recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
    op: "create",
    targetId: "m1",
    payload: VARIANT_PAYLOAD,
    status: "pending",
    ...over,
  };
}

const COMPANION: SidechatProposalMessageCompanion = {
  chatId: "c1",
  branchId: "b1",
  message: { id: "m1", position: 3, content: "She sat by the opened door slowly, exactly as staged.", updatedAt: "2026-11-06T10:00:00Z" },
  variants: [
    { id: "v1", variantIndex: 0, content: "She sat by the opened door slowly, exactly as staged.", isSelected: true, modelId: null, presetName: null },
    { id: "v2", variantIndex: 1, content: "second swipe", isSelected: false, modelId: null, presetName: null },
  ],
};

// The wire doubles for the REAL ingest action (the pending-user-message
// seed pattern — minimal typed wire shape).
function makeVariant(over: Partial<AppMessage["variants"][number]>): AppMessage["variants"][number] {
  return {
    id: brandId<MessageVariantId>("v1"),
    messageId: brandId<MessageId>("m1"),
    variantIndex: 0,
    content: "first swipe",
    isSelected: true,
    finishReason: "stop",
    createdAt: "2026-11-01T00:00:00Z",
    modelId: "rp-model",
    presetName: null,
    tokenCount: 3,
    attachmentsJson: null,
    sceneTracker: null,
    ...over,
  };
}

function makeMessage(variants: AppMessage["variants"]): AppMessage {
  return {
    id: brandId<MessageId>("m1"),
    chatId: brandId<ChatId>("c1"),
    branchId: brandId<ChatBranchId>("b1"),
    role: "assistant",
    authorType: "assistant",
    position: 3,
    content: "first swipe",
    state: "complete",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    tokenCount: 3,
    variants,
    selectedVariantIndex: 0,
    modelId: "rp-model",
    sceneTracker: null,
    attachments: [],
  };
}

function seedChat(variants: AppMessage["variants"], activeChatId = "c1", activeBranchId = "b1") {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: wireChat({ id: brandId<ChatId>(activeChatId), activeBranchId: brandId<ChatBranchId>(activeBranchId) }),
    activeBranch: wireBranch({ id: brandId<ChatBranchId>(activeBranchId), chatId: brandId<ChatId>(activeChatId) }),
    messages: [makeMessage(variants)],
  });
}

function storedMessage(): AppMessage {
  const stored = useSnapshotStore.getState().messagesById["m1"];
  if (stored === undefined) throw new Error("message m1 not loaded");
  return stored;
}

beforeEach(() => {
  mocks.applyDirectorMessageProposal.mockReset();
  mocks.rejectDirectorMessageProposal.mockReset();
  mocks.ingestMessageCompanionAction.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  useSnapshotStore.setState({ activeChat: null, activeBranch: null, messagesById: {}, messageOrder: [] });
});

// ─── message-edit ───────────────────────────────────────────────────────────

describe("DirectorMessageProposalCard — message-edit review", () => {
  it("pending review: title/chip/target/instruction/diff labels + full candidate, buttons enabled, no call", () => {
    const { getByTestId, getByText } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );
    const card = getByTestId("director-message-proposal-card");
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(card.getAttribute("data-record-type")).toBe("message-edit");
    expect(getByTestId("director-message-proposal-status").textContent).toBe(
      "agent.message_edit_proposal.status_pending",
    );
    // The target reply is NAMED (the interpolated EN template), never a bare payload.
    expect(getByTestId("director-message-proposal-target").textContent).toBe("Reply variant 1");
    expect(getByTestId("director-message-proposal-instruction").textContent).toContain(
      "agent.message_edit_proposal.instruction_label",
    );
    expect(getByTestId("director-message-proposal-instruction").textContent).toContain(
      "Fix the pose — she is sitting, not standing.",
    );
    // The ordinary editor's word diff is part of the review (its +/− counts
    // came from the real word diff: +7 added, −1 removed)...
    expect(card.textContent).toContain("message_ai_editor_changes");
    expect(card.textContent).toContain("+7 -1");
    // ...and the candidate preview block carries the label + the FULL text.
    expect(card.textContent).toContain("agent.message_edit_proposal.candidate_label");
    expect(card.textContent).toContain(EDIT_PAYLOAD.candidate);
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).toBeNull();
    expect(getByTestId("director-message-proposal-reject").getAttribute("disabled")).toBeNull();
    expect(mocks.applyDirectorMessageProposal).not.toHaveBeenCalled();
    expect(mocks.rejectDirectorMessageProposal).not.toHaveBeenCalled();
  });

  it("the candidate preview is never truncated (a 12-paragraph candidate renders whole)", () => {
    const longEdit = editProposal({
      payload: { ...EDIT_PAYLOAD, candidate: FULL_CANDIDATE },
    });
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={longEdit} threadId="thread-1" />,
    );
    const card = getByTestId("director-message-proposal-card");
    for (let i = 1; i <= 12; i++) {
      expect(card.textContent).toContain(`Paragraph ${i}:`);
    }
    expect(card.textContent).toContain(
      "pretends the city is asleep around her.",
    );
  });

  it("Apply calls apply once with (threadId, toolCallId), ingests the companion, shows the applied line", async () => {
    mocks.applyDirectorMessageProposal.mockResolvedValue({
      proposal: editProposal({ status: "applied" }),
      message: COMPANION,
    });
    const onResolved = mock();
    const { getByTestId, queryByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" onResolved={onResolved} />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() => expect(mocks.applyDirectorMessageProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyDirectorMessageProposal).toHaveBeenCalledWith("thread-1", "tc-prop");
    // The companion lands in the CANONICAL action, never an unscoped snapshot
    // hand-rolled in the card.
    await waitFor(() => expect(mocks.ingestMessageCompanionAction).toHaveBeenCalledTimes(1));
    expect(mocks.ingestMessageCompanionAction).toHaveBeenCalledWith(COMPANION);
    await waitFor(() =>
      expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(getByTestId("director-message-proposal-status").textContent).toBe(
      "agent.message_edit_proposal.status_applied",
    );
    expect(getByTestId("director-message-proposal-resolved-line").textContent).toBe(
      "agent.message_edit_proposal.applied_line",
    );
    // onResolved hands the host the final row — virtualization cannot resurrect pending controls.
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]?.[0]?.status).toBe("applied");
    expect(queryByTestId("director-message-proposal-apply")).toBeNull();
    expect(queryByTestId("director-message-proposal-reject")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("a non-already-resolved 409 (stale base) pins the conflict line, keeps pending, disables Apply", async () => {
    mocks.applyDirectorMessageProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "The selected message variant's content changed before this edit could be applied.",
      ),
    );
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() =>
      expect(getByTestId("director-message-proposal-conflict-line").textContent).toBe(
        "agent.message_edit_proposal.conflict_line",
      ),
    );
    expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).not.toBeNull();
    // Reject stays available — the honest exit from a stale review.
    expect(getByTestId("director-message-proposal-reject").getAttribute("disabled")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.ingestMessageCompanionAction).not.toHaveBeenCalled();
  });

  it("a 404 (deleted/moved target) pins the missing line and disables Apply", async () => {
    mocks.applyDirectorMessageProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(404, "Message 'm1' was not found in the proposal's branch."),
    );
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() =>
      expect(getByTestId("director-message-proposal-missing-line").textContent).toBe(
        "agent.message_edit_proposal.source_missing_line",
      ),
    );
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).not.toBeNull();
    expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

// ─── message-variant ────────────────────────────────────────────────────────

describe("DirectorMessageProposalCard — message-variant review", () => {
  it("pending review: title/target/sources count, the FULL Director reply, NO diff block, Save enabled with ONE source", () => {
    const multi = variantProposal({
      payload: {
        sources: [
          { messageId: "m1", variantId: "v1", position: 3, variantNumber: 2 },
          { messageId: "m1", variantId: "v2", position: 3, variantNumber: 3 },
        ],
        content: FULL_CANDIDATE,
      },
    });
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={multi} threadId="thread-1" />,
    );
    const card = getByTestId("director-message-proposal-card");
    expect(card.getAttribute("data-record-type")).toBe("message-variant");
    expect(getByTestId("director-message-proposal-target").textContent).toContain("New swipe for reply variant 2");
    // The multi-source count line (count + n interpolation, EN template).
    expect(getByTestId("director-message-proposal-target").textContent).toContain("Based on 2 swipes");
    // The COMPLETE Director text — no diff, no truncation.
    expect(card.textContent).not.toContain("message_ai_editor_changes");
    expect(card.textContent).toContain("agent.message_variant_proposal.candidate_label");
    expect(card.textContent).toContain("Paragraph 12:");
    // A single source suffices — Save is enabled (never the merge tool's
    // two-source minimum).
    expect(getByTestId("director-message-proposal-apply").textContent).toBe(
      "agent.message_variant_proposal.save",
    );
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).toBeNull();
    expect(mocks.applyDirectorMessageProposal).not.toHaveBeenCalled();
  });

  it("Save (single source) applies, ingests the companion and shows the saved line", async () => {
    mocks.applyDirectorMessageProposal.mockResolvedValue({
      proposal: variantProposal({ status: "applied" }),
      message: COMPANION,
    });
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={variantProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() => expect(mocks.applyDirectorMessageProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyDirectorMessageProposal).toHaveBeenCalledWith("thread-1", "tc-prop");
    await waitFor(() =>
      expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(getByTestId("director-message-proposal-status").textContent).toBe(
      "agent.message_variant_proposal.status_applied",
    );
    expect(getByTestId("director-message-proposal-resolved-line").textContent).toBe(
      "agent.message_variant_proposal.saved_line",
    );
    await waitFor(() => expect(mocks.ingestMessageCompanionAction).toHaveBeenCalledWith(COMPANION));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("a 404 pins the variant missing line and disables Save", async () => {
    mocks.applyDirectorMessageProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(404, "Variant 'v1' was not found on message 'm1'."),
    );
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={variantProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() =>
      expect(getByTestId("director-message-proposal-missing-line").textContent).toBe(
        "agent.message_variant_proposal.source_missing_line",
      ),
    );
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).not.toBeNull();
  });
});

// ─── Shared resolve machine ─────────────────────────────────────────────────

describe("DirectorMessageProposalCard — resolve machine (both types)", () => {
  it("Reject resolves rejected, no ingestion, no toast (edit)", async () => {
    mocks.rejectDirectorMessageProposal.mockResolvedValue({
      proposal: editProposal({ status: "rejected" }),
    });
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-reject"));

    await waitFor(() => expect(mocks.rejectDirectorMessageProposal).toHaveBeenCalledTimes(1));
    expect(mocks.rejectDirectorMessageProposal).toHaveBeenCalledWith("thread-1", "tc-prop");
    await waitFor(() =>
      expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("director-message-proposal-resolved-line").textContent).toBe(
      "agent.message_edit_proposal.rejected_line",
    );
    expect(mocks.ingestMessageCompanionAction).not.toHaveBeenCalled();
    expect(mocks.applyDirectorMessageProposal).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("duplicate clicks resolve once — the busy guard", async () => {
    let resolveApply!: (v: { proposal: RecordProposal }) => void;
    mocks.applyDirectorMessageProposal.mockReturnValue(
      new Promise<{ proposal: RecordProposal }>((res) => {
        resolveApply = res;
      }),
    );
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));
    fireEvent.click(getByTestId("director-message-proposal-apply"));
    // Both buttons disable while the request runs (a second click would race
    // the server's single-row resolution into a typed 409).
    await waitFor(() =>
      expect(getByTestId("director-message-proposal-reject").getAttribute("disabled")).not.toBeNull(),
    );
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).not.toBeNull();

    resolveApply({ proposal: editProposal({ status: "applied" }) });
    await waitFor(() =>
      expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(mocks.applyDirectorMessageProposal).toHaveBeenCalledTimes(1);
  });

  it("the typed already-resolved 409 shows the server's final status and fires onResolved", async () => {
    mocks.applyDirectorMessageProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );
    const onResolved = mock();
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" onResolved={onResolved} />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() =>
      expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("director-message-proposal-status").textContent).toBe(
      "agent.message_edit_proposal.status_rejected",
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]?.[0]?.status).toBe("rejected");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("any other failure keeps the card pending and toasts", async () => {
    mocks.applyDirectorMessageProposal.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({})} threadId="thread-1" />,
    );

    fireEvent.click(getByTestId("director-message-proposal-apply"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("boom");
    expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("director-message-proposal-apply").getAttribute("disabled")).toBeNull();
  });

  it("the persisted status seeds the card (a reloaded thread renders applied with no fetch)", () => {
    const { getByTestId, queryByTestId } = render(
      <DirectorMessageProposalCard proposal={editProposal({ status: "applied" })} threadId="thread-1" />,
    );
    expect(getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("applied");
    expect(getByTestId("director-message-proposal-resolved-line").textContent).toBe(
      "agent.message_edit_proposal.applied_line",
    );
    expect(queryByTestId("director-message-proposal-apply")).toBeNull();
    expect(queryByTestId("director-message-proposal-reject")).toBeNull();
    expect(mocks.applyDirectorMessageProposal).not.toHaveBeenCalled();
    expect(mocks.rejectDirectorMessageProposal).not.toHaveBeenCalled();
  });

  it("an unshaped payload renders the frame empty — no throw", () => {
    let card: ReturnType<typeof render> | null = null;
    expect(() => {
      card = render(
        <DirectorMessageProposalCard proposal={editProposal({ payload: null })} threadId="thread-1" />,
      );
    }).not.toThrow();
    expect(card!.getByTestId("director-message-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(card!.queryByTestId("director-message-proposal-target")).toBeNull();
  });
});

// ─── The canonical ingest action (the REAL one, against the real store) ─────

describe("ingestMessageCompanionAction — target-scoped canonical ingestion", () => {
  it("a Save companion appends + selects the new variant, completing it like the server DTO", () => {
    seedChat([
      makeVariant({ id: brandId<MessageVariantId>("v1"), variantIndex: 0, content: "first swipe", isSelected: false }),
    ]);
    const save: SidechatProposalMessageCompanion = {
      chatId: "c1",
      branchId: "b1",
      message: { id: "m1", position: 3, content: "director text", updatedAt: "2026-11-06T10:00:00Z" },
      variants: [
        { id: "v1", variantIndex: 0, content: "first swipe", isSelected: false, modelId: "rp-model", presetName: null },
        { id: "v2", variantIndex: 1, content: "director text", isSelected: true, modelId: null, presetName: null },
      ],
    };

    realChatActions.ingestMessageCompanionAction(save);

    const stored = storedMessage();
    // Every previous swipe is preserved byte-for-byte (Save never overwrites).
    expect(stored.variants[0]?.content).toBe("first swipe");
    expect(stored.variants[0]?.finishReason).toBe("stop");
    expect(stored.variants[0]?.modelId).toBe("rp-model");
    // The NEW variant: DIRECTOR authorship — no provenance, completed wire fields.
    expect(stored.variants[1]?.content).toBe("director text");
    expect(String(stored.variants[1]?.messageId)).toBe("m1");
    expect(stored.variants[1]?.finishReason).toBeNull();
    expect(stored.variants[1]?.attachmentsJson).toBeNull();
    expect(stored.variants[1]?.sceneTracker).toBeNull();
    // The save selected the new swipe; the row mirrors it.
    expect(stored.selectedVariantIndex).toBe(1);
    expect(stored.content).toBe("director text");
    expect(stored.modelId).toBeNull();
    expect(stored.updatedAt).toBe("2026-11-06T10:00:00Z");
    // Only ONE message changed — the loaded set is untouched otherwise.
    expect(Object.keys(useSnapshotStore.getState().messagesById)).toEqual(["m1"]);
  });

  it("an Edit companion rewrites the selected variant and preserves the narrowed-away fields", () => {
    seedChat([
      makeVariant({
        id: brandId<MessageVariantId>("v1"),
        variantIndex: 0,
        content: "first swipe",
        isSelected: true,
        attachmentsJson: '[{"id":"att-1"}]',
        sceneTracker: null,
      }),
      makeVariant({ id: brandId<MessageVariantId>("v2"), variantIndex: 1, content: "second swipe", isSelected: false }),
    ]);
    const apply: SidechatProposalMessageCompanion = {
      chatId: "c1",
      branchId: "b1",
      message: { id: "m1", position: 3, content: "edited text", updatedAt: "2026-11-06T11:00:00Z" },
      variants: [
        { id: "v1", variantIndex: 0, content: "edited text", isSelected: true, modelId: null, presetName: null },
        { id: "v2", variantIndex: 1, content: "second swipe", isSelected: false, modelId: "rp-model", presetName: null },
      ],
    };

    realChatActions.ingestMessageCompanionAction(apply);

    const stored = storedMessage();
    // The narrowed companion's fields landed; the image slot JSON the view
    // does not carry SURVIVED (never dropped by the merge).
    expect(stored.variants[0]?.content).toBe("edited text");
    expect(stored.variants[0]?.attachmentsJson).toBe('[{"id":"att-1"}]');
    expect(stored.variants[0]?.finishReason).toBe("stop");
    expect(stored.variants[1]?.content).toBe("second swipe");
    expect(stored.selectedVariantIndex).toBe(0);
    expect(stored.content).toBe("edited text");
    // The DTO projection: the selected variant's own attachment set wins
    // (parsed from its preserved attachmentsJson).
    expect(stored.attachments?.map((attachment) => attachment.id)).toEqual(["att-1"]);
  });

  it("a companion for a DIFFERENT open conversation is a no-op (never merges across chats)", () => {
    seedChat([makeVariant({})]);
    const foreign: SidechatProposalMessageCompanion = {
      chatId: "other-chat",
      branchId: "b1",
      message: { id: "m1", position: 3, content: "foreign", updatedAt: "2026-11-06T10:00:00Z" },
      variants: [{ id: "v1", variantIndex: 0, content: "foreign", isSelected: true, modelId: null, presetName: null }],
    };

    realChatActions.ingestMessageCompanionAction(foreign);

    expect(storedMessage().content).toBe("first swipe");
  });

  it("a companion naming a message that is not loaded is a no-op (the view refetches on switch)", () => {
    seedChat([makeVariant({})]);
    const unloaded: SidechatProposalMessageCompanion = {
      chatId: "c1",
      branchId: "b1",
      message: { id: "m999", position: 9, content: "ghost", updatedAt: "2026-11-06T10:00:00Z" },
      variants: [{ id: "w1", variantIndex: 0, content: "ghost", isSelected: true, modelId: null, presetName: null }],
    };

    realChatActions.ingestMessageCompanionAction(unloaded);

    expect(storedMessage().content).toBe("first swipe");
    expect(useSnapshotStore.getState().messagesById["m999"]).toBeUndefined();
  });
});

// ─── Locale parity (the owner-facing copy, byte-exact) ──────────────────────

describe("DirectorMessageProposalCard — locale copy (DMT-30)", () => {
  it("the EN/RU tables carry the apply-vs-save distinction and the conflict line (byte-exact)", () => {
    const enTable = en as Record<string, string>;
    const ruTable = ru as Record<string, string>;
    expect(enTable["agent.message_edit_proposal.apply"]).toBe("Apply");
    expect(ruTable["agent.message_edit_proposal.apply"]).toBe("Применить правку");
    expect(enTable["agent.message_variant_proposal.save"]).toBe("Save as separate swipe");
    expect(ruTable["agent.message_variant_proposal.save"]).toBe("Сохранить как отдельный свайп");
    expect(enTable["agent.message_edit_proposal.conflict_line"]).toBe(
      "The reply changed since the review — the corrections were not applied.",
    );
    expect(ruTable["agent.message_edit_proposal.conflict_line"]).toBe(
      "Ответ изменился после просмотра — правки не применены.",
    );
    expect(ruTable["agent.message_variant_proposal.saved_line"]).toBe("Сохранено как отдельный свайп.");
    expect(ruTable["agent.message_edit_proposal.applied_line"]).toBe("Правки применены к ответу.");
  });
});
