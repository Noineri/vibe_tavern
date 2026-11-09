/**
 * TrackerSceneProposalCard — DIRECTOR_MODE_PLAN DR-10b.
 *
 * Pins the card's own contract: the title + tinted chip; the card-composed
 * summary line (the scene schema's field labels/keys — the tool sends no
 * summary, so the card composes its own per the tool's input-schema doc); the
 * SHARED TrackerTemplateSchemaPreview rendering the payload's SCENE part ONLY
 * (an objective half riding the payload is dropped at the parse — A9, never
 * rendered); Accept calls the body-less apply with the (threadId, toolCallId)
 * pair and refetches the active chat; Reject resolves without touching the
 * chat; the applied line + the muted save hint (the chat settings' existing
 * «Сохранить как заготовку персонажа» wording, mock §6 byte-exact through the
 * composition); the typed already-resolved 409; other failures toast and keep
 * the card pending; both buttons disable while a request runs; an unshaped
 * payload renders empty without a throw; the locale tables carry the RU canon
 * (mock §6, byte-exact) and the `propose_tracker_template` tool label is
 * pinned.
 *
 * Runner: bun:test + happy-dom. The snapshot store is exercised for real
 * (seeded/reset per test); `useT` (with the two interpolated keys served from
 * the bundled EN table), the proposals API, `fetchChatAction`, and the sonner
 * toast are mocked — the ObjectiveProposalCard.test.tsx precedents.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireChat } from "../../../../test/wire-fixtures.js";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { brandId, normalizeInsightsConfig, type ChatId, type TrackerTemplate } from "@vibe-tavern/domain";
import { normalizeTrackerTemplate, TRACKER_TEMPLATE_VERSION } from "@vibe-tavern/domain";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";

const mocks = {
  applyTrackerSceneProposal: mock(),
  rejectTrackerSceneProposal: mock(),
  fetchChatAction: mock(),
  toastError: mock(),
};
const realProposalsApi = await import("../../../api/agent-thread-proposals-api.js");
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
const realSonner = await import("sonner");

installI18nContextSeam({
  interpolateKeys: [
    "agent.tracker_scene_proposal.summary_prefix",
    "agent.tracker_scene_proposal.save_hint",
    "insights_template_save_as_character",
  ],
});

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: mocks.toastError },
}));

mock.module("../../../api/agent-thread-proposals-api.js", () => ({
  ...realProposalsApi,
  applyTrackerSceneProposal: mocks.applyTrackerSceneProposal,
  rejectTrackerSceneProposal: mocks.rejectTrackerSceneProposal,
}));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  fetchChatAction: mocks.fetchChatAction,
}));

let TrackerSceneProposalCard: typeof import("./TrackerSceneProposalCard.js").TrackerSceneProposalCard;
let trackerSceneSummaryFields: typeof import("./TrackerSceneProposalCard.js").trackerSceneSummaryFields;
let TRACKER_SCENE_RECORD_TYPE: typeof import("./TrackerSceneProposalCard.js").TRACKER_SCENE_RECORD_TYPE;
beforeAll(async () => {
  ({ TrackerSceneProposalCard, trackerSceneSummaryFields, TRACKER_SCENE_RECORD_TYPE } = await import(
    "./TrackerSceneProposalCard.js"
  ));
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The payload's scene half, wire-shaped as `propose_tracker_template` emits
 *  it after the delegate run (mock §6's cat story: place / time of day /
 *  clothes / fullness / habits). One node carries a label, one does not, so
 *  the summary's label-else-key fallback is pinned by the same fixture. */
const SCENE_HALF = {
  enabled: true,
  config: {
    schema: {
      "Место": { $type: "string" },
      "Время суток": { $type: "string" },
      "Одежда Арчи": { $type: "string" },
      "Сытость": { $type: "string", label: "насколько он сыт" },
    },
  },
};

/** The payload an objective half rides ILLEGALLY (A9 drops it at the parse):
 *  a goals-mode objective with a distinctive marker description. */
const SMUGGLED_OBJECTIVE = {
  enabled: true,
  state: {
    mode: "goals",
    objectiveDescription: "",
    shortTermGoals: [{ id: "g1", description: "SECRET-OBJECTIVE-GOAL", status: "pending" }],
    longTermGoal: null,
    autoCheckFrequency: 0,
    contextWindow: 5,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
  },
};

function proposal(over: Partial<RecordProposal> & { payload?: unknown }): RecordProposal {
  return {
    kind: "record",
    id: "tc-scene",
    recordType: "tracker-scene",
    op: "update",
    targetId: "c1",
    payload: { scene: SCENE_HALF },
    status: "pending",
    ...over,
  };
}

/** Seed the ACTIVE chat the card refetches after an apply (the
 *  ObjectiveProposalCard seed pattern). */
function seedChat() {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: wireChat({ id: brandId<ChatId>("c1"), insightsConfig: normalizeInsightsConfig({ objectiveEnabled: true, trackerEnabled: false }) }),
  });
}

beforeEach(() => {
  seedChat();
  mocks.applyTrackerSceneProposal.mockReset();
  mocks.rejectTrackerSceneProposal.mockReset();
  mocks.fetchChatAction.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  useSnapshotStore.setState({ activeChat: null });
});

// ─── The pure summary composition ───────────────────────────────────────────

describe("trackerSceneSummaryFields", () => {
  it("lists each top-level field's label, falling back to its key", () => {
    // Through the card's own parse (the domain normalizer) — the function
    // under test receives the NORMALIZED template, exactly as in the card.
    const template = normalizeTrackerTemplate({
      version: TRACKER_TEMPLATE_VERSION,
      scene: SCENE_HALF,
      objective: null,
    });
    expect(template).not.toBeNull();
    expect(trackerSceneSummaryFields(template!)).toEqual([
      "Место",
      "Время суток",
      "Одежда Арчи",
      "насколько он сыт",
    ]);
  });

  it("nested object children are detail rows, not summary entries; no scene renders none", () => {
    const nested = normalizeTrackerTemplate({
      version: TRACKER_TEMPLATE_VERSION,
      objective: null,
      scene: {
        enabled: true,
        config: {
          schema: {
            outer: { $type: "object", properties: { inner: { $type: "string" } } },
          },
        },
      },
    });
    expect(nested).not.toBeNull();
    expect(trackerSceneSummaryFields(nested!)).toEqual(["outer"]);
    expect(trackerSceneSummaryFields({ version: 1, scene: null, objective: null })).toEqual([]);
  });
});

// ─── The card ───────────────────────────────────────────────────────────────

describe("TrackerSceneProposalCard (DR-10b)", () => {
  it("pending: title + chip + composed summary + the shared preview of the scene fields", () => {
    const { getByTestId } = render(
      <TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />,
    );
    const card = getByTestId("tracker-scene-proposal-card");
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(card.getAttribute("data-record-type")).toBe("tracker-scene");
    expect(TRACKER_SCENE_RECORD_TYPE).toBe("tracker-scene");
    expect(getByTestId("tracker-scene-proposal-status").textContent).toBe(
      "agent.tracker_scene_proposal.status_pending",
    );
    // The composed summary (EN table interpolation through the seam).
    expect(getByTestId("tracker-scene-proposal-summary").textContent).toBe(
      "Fields for this story: Место, Время суток, Одежда Арчи, насколько он сыт.",
    );
    // The SHARED preview renders the scene fields inside the mock §6 box.
    const preview = getByTestId("tracker-scene-proposal-preview");
    for (const key of ["Место", "Время суток", "Одежда Арчи", "Сытость"]) {
      expect(preview.textContent).toContain(key);
    }
    expect(getByTestId("tracker-scene-proposal-accept").getAttribute("disabled")).toBeNull();
    expect(getByTestId("tracker-scene-proposal-reject").getAttribute("disabled")).toBeNull();
  });

  it("an objective half riding the payload is dropped at the parse — never rendered (A9)", () => {
    const { getByTestId } = render(
      <TrackerSceneProposalCard
        proposal={proposal({ payload: { scene: SCENE_HALF, objective: SMUGGLED_OBJECTIVE } })}
        threadId="thread-1"
      />,
    );
    expect(getByTestId("tracker-scene-proposal-card").textContent).not.toContain("SECRET-OBJECTIVE-GOAL");
    // The scene half still renders in full.
    expect(getByTestId("tracker-scene-proposal-preview").textContent).toContain("Место");
  });

  it("Accept calls the body-less apply once with (threadId, toolCallId) and refetches the chat", async () => {
    mocks.applyTrackerSceneProposal.mockResolvedValue({ proposal: proposal({ status: "applied" }) });
    mocks.fetchChatAction.mockResolvedValue(undefined);
    const { getByTestId } = render(<TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("tracker-scene-proposal-accept"));

    await waitFor(() => expect(mocks.applyTrackerSceneProposal).toHaveBeenCalledTimes(1));
    expect(mocks.applyTrackerSceneProposal).toHaveBeenCalledWith("thread-1", "tc-scene");
    await waitFor(() => expect(mocks.fetchChatAction).toHaveBeenCalledTimes(1));
    expect(mocks.fetchChatAction).toHaveBeenCalledWith("c1");
    await waitFor(() =>
      expect(getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Reject resolves rejected without touching the chat", async () => {
    mocks.rejectTrackerSceneProposal.mockResolvedValue({ proposal: proposal({ status: "rejected" }) });
    const { getByTestId } = render(<TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("tracker-scene-proposal-reject"));

    await waitFor(() => expect(mocks.rejectTrackerSceneProposal).toHaveBeenCalledTimes(1));
    expect(mocks.rejectTrackerSceneProposal).toHaveBeenCalledWith("thread-1", "tc-scene");
    await waitFor(() =>
      expect(getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(getByTestId("tracker-scene-proposal-status").textContent).toBe(
      "agent.tracker_scene_proposal.status_rejected",
    );
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("applied (stored or after Accept): the applied line + the muted save hint, no buttons", async () => {
    const { getByTestId, queryByTestId } = render(
      <TrackerSceneProposalCard proposal={proposal({ status: "applied" })} threadId="thread-1" />,
    );
    expect(getByTestId("tracker-scene-proposal-status").textContent).toBe(
      "agent.tracker_scene_proposal.status_applied",
    );
    expect(getByTestId("tracker-scene-applied-line").textContent).toBe(
      "agent.tracker_scene_proposal.applied_line",
    );
    // The hint interpolates the EXISTING save-as-character action wording.
    expect(getByTestId("tracker-scene-save-hint").textContent).toBe(
      'To keep this setup for the character, use the chat settings — “Save as character template”.',
    );
    expect(queryByTestId("tracker-scene-proposal-accept")).toBeNull();
    expect(queryByTestId("tracker-scene-proposal-reject")).toBeNull();
    expect(queryByTestId("tracker-scene-proposal-preview")).toBeNull();
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
  });

  it("409 already-resolved shows the server's final status", async () => {
    mocks.applyTrackerSceneProposal.mockRejectedValue(
      new realProposalsApi.ObjectiveProposalApiError(
        409,
        "This proposal was already rejected.",
        realProposalsApi.OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
        "rejected",
      ),
    );
    const { getByTestId } = render(<TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("tracker-scene-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("rejected"),
    );
    expect(mocks.fetchChatAction).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("any other failure keeps the card pending and toasts", async () => {
    mocks.applyTrackerSceneProposal.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(<TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("tracker-scene-proposal-accept"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("boom");
    expect(getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(getByTestId("tracker-scene-proposal-accept").getAttribute("disabled")).toBeNull();
  });

  it("both buttons disable while the request runs", async () => {
    let resolveApply!: (v: { proposal: RecordProposal }) => void;
    mocks.applyTrackerSceneProposal.mockReturnValue(
      new Promise<{ proposal: RecordProposal }>((res) => {
        resolveApply = res;
      }),
    );
    const { getByTestId } = render(<TrackerSceneProposalCard proposal={proposal({})} threadId="thread-1" />);

    fireEvent.click(getByTestId("tracker-scene-proposal-accept"));

    await waitFor(() =>
      expect(getByTestId("tracker-scene-proposal-reject").getAttribute("disabled")).not.toBeNull(),
    );
    expect(getByTestId("tracker-scene-proposal-accept").getAttribute("disabled")).not.toBeNull();
    resolveApply({ proposal: proposal({ status: "applied" }) });
    await waitFor(() =>
      expect(getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("applied"),
    );
  });

  it("unshaped payload renders the header without a throw and no review block", () => {
    let view: ReturnType<typeof render> | null = null;
    expect(() => {
      view = render(
        <TrackerSceneProposalCard proposal={proposal({ payload: null })} threadId="thread-1" />,
      );
    }).not.toThrow();
    expect(view!.getByTestId("tracker-scene-proposal-card").getAttribute("data-status")).toBe("pending");
    expect(view!.queryByTestId("tracker-scene-proposal-summary")).toBeNull();
    expect(view!.queryByTestId("tracker-scene-proposal-preview")).toBeNull();
    expect(view!.queryByTestId("tracker-scene-proposal-accept")).toBeNull();
    expect(view!.queryByTestId("tracker-scene-proposal-reject")).toBeNull();
  });

  it("locale tables carry the card strings (RU canon from mock §6, byte-exact)", () => {
    const record = en as Record<string, string>;
    expect(record["agent.tracker_scene_proposal.title"]).toBe("Scene tracker");
    expect(record["agent.tracker_scene_proposal.status_pending"]).toBe("awaiting decision");
    expect(record["agent.tracker_scene_proposal.status_applied"]).toBe("accepted");
    expect(record["agent.tracker_scene_proposal.status_rejected"]).toBe("rejected");
    expect(record["agent.tracker_scene_proposal.applied_line"]).toBe(
      "The scene tracker is on with these fields.",
    );
    expect(record["agent.tracker_scene_proposal.save_hint"]).toBe(
      "To keep this setup for the character, use the chat settings — “{action}”.",
    );
    expect(record["agent.tracker_scene_proposal.summary_prefix"]).toBe("Fields for this story: {fields}.");

    const ruRecord = ru as Record<string, string>;
    expect(ruRecord["agent.tracker_scene_proposal.title"]).toBe("Трекер сцены");
    expect(ruRecord["agent.tracker_scene_proposal.status_pending"]).toBe("ждёт решения");
    expect(ruRecord["agent.tracker_scene_proposal.status_applied"]).toBe("принято");
    expect(ruRecord["agent.tracker_scene_proposal.status_rejected"]).toBe("отклонено");
    expect(ruRecord["agent.tracker_scene_proposal.applied_line"]).toBe("Трекер сцены включён с этими полями.");
    expect(ruRecord["agent.tracker_scene_proposal.summary_prefix"]).toBe("Поля для этой истории: {fields}.");
    // The hint + the EXISTING save action compose into the mock §6 sentence,
    // byte-exact.
    expect(
      ruRecord["agent.tracker_scene_proposal.save_hint"].replace(
        "{action}",
        ruRecord["insights_template_save_as_character"],
      ),
    ).toBe("Сохранить настройку для персонажа можно в настройках чата — «Сохранить как заготовку персонажа».");
  });

  it("pins the propose_tracker_template tool label (the profile modal's sidechat toggle)", async () => {
    const { SIDECHAT_PROFILE_TOOL_LABEL_KEYS } = await import(
      "../../shared/agent-shell/agent-tool-labels.js"
    );
    expect(SIDECHAT_PROFILE_TOOL_LABEL_KEYS.propose_tracker_template).toBe(
      "agent_tool_propose_tracker_template",
    );
    const record = en as Record<string, string>;
    const ruRecord = ru as Record<string, string>;
    expect(record["agent_tool_propose_tracker_template"]).toBe("Propose a scene tracker");
    expect(ruRecord["agent_tool_propose_tracker_template"]).toBe("Предлагать трекер сцены");
  });
});
