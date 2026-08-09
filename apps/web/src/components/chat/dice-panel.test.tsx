import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { DiceDefinitionsResponse, DiceLaneState, DiceRollSnapshot } from "../../api/types.js";

useDomEnv();

let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;

const mocks = {
  activeChat: null as null | {
    id: string;
    characterId: string;
    insightsConfig?: { diceEnabled?: boolean; diceMode?: "normal" | "immersive" };
  },
  activeBranch: null as null | { id: string },
  character: { id: "char_1", name: "Hero" } as { id: string; name: string } | null,
  persona: { id: "persona_1", name: "Player" } as { id: string; name: string } | null,
  definitions: null as DiceDefinitionsResponse | null,
  lanes: null as { normal: DiceLaneState; immersive: DiceLaneState } | null,
  rolling: false,
  lastError: null as string | null,
  mobile: false,
  actions: {
    setScope: mock(),
    roll: mock(async () => "request_1"),
    removeRoll: mock(async () => undefined),
    clearLane: mock(async () => undefined),
    setIncluded: mock(async () => undefined),
    chooseAttempt: mock(async () => undefined),
  },
};
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");
const realSnapshotStore = await import("../../stores/snapshot-store.js");
const realDiceStore = await import("../../stores/dice-store.js");
const realExperienceStore = await import("../../stores/experience-store.js");
const realTooltip = await import("../shared/Tooltip.js");
const realBottomSheet = await import("../shared/BottomSheet.js");
const realQueueManager = await import("./QueueManager.js");
const realInputArea = await import("./InputArea.js");
const realMessageList = await import("./MessageList.js");
const realMessageAiEditorModal = await import("./MessageAiEditorModal.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (vars?.count != null) return `${key}:${String(vars.count)}`;
      if (vars?.label != null && vars?.actor == null && vars?.total == null) return `${key}:${String(vars.label)}`;
      if (vars?.actor != null || vars?.label != null || vars?.total != null) {
        return `${key}:${String(vars.actor ?? "")}:${String(vars.label ?? "")}:${String(vars.total ?? "")}`;
      }
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => mocks.mobile,
}));

mock.module("../../stores/snapshot-store.js", () => ({
  ...realSnapshotStore,
  useSnapshotStore: (selector: (state: {
    activeChat: typeof mocks.activeChat;
    activeBranch: typeof mocks.activeBranch;
    character: typeof mocks.character;
    persona: typeof mocks.persona;
  }) => unknown) => selector({
    activeChat: mocks.activeChat,
    activeBranch: mocks.activeBranch,
    character: mocks.character,
    persona: mocks.persona,
  }),
}));

mock.module("../../stores/dice-store.js", () => {
  const useDiceStore = (selector: (state: typeof mocks.actions) => unknown) => selector(mocks.actions);
  useDiceStore.getState = () => mocks.actions;
  return {
    useDiceDefinitions: () => mocks.definitions,
    useDiceLanes: () => mocks.lanes,
    useDiceRolling: () => mocks.rolling,
    useDiceLastError: () => mocks.lastError,
    useDiceStore,
  };
});

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// Mock the Experience store so the ExperienceLauncher returns null (no config)
// and its setScope/rehydrate do not make real API calls inside the Dice tests.
mock.module("../../stores/experience-store.js", () => ({
  ...realExperienceStore,
  useExperienceConfig: () => null,
  useExperienceSession: () => null,
  useExperienceEffects: () => [],
  useExperienceQueuedAttachment: () => null,
  useExperienceReportStatus: () => null,
  useExperienceLoading: () => false,
  useExperienceLastError: () => null,
  useExperienceModalOpen: () => false,
  useExperienceDetached: () => false,
  useExperienceStore: { getState: () => ({ setScope: () => {}, openModal: () => {}, closeModal: () => {}, setDetached: () => {} }) },
}));

mock.module("../shared/BottomSheet.js", () => ({
  ...realBottomSheet,
  BottomSheet: ({ open, title, children }: { open: boolean; title?: ReactNode; children: ReactNode }) =>
    open ? <div data-testid="bottom-sheet">{title}{children}</div> : null,
}));

mock.module("./QueueManager.js", () => ({ ...realQueueManager, QueueManager: () => <div data-testid="queue-manager" /> }));
mock.module("./InputArea.js", () => ({ ...realInputArea, InputArea: () => <div data-testid="input-area" /> }));
mock.module("./MessageList.js", () => ({ ...realMessageList, MessageList: () => <div data-testid="message-list" /> }));
mock.module("./MessageAiEditorModal.js", () => ({ ...realMessageAiEditorModal, MessageAiEditorModal: () => null }));

let DicePanel: typeof import("./DicePanel.js").DicePanel;
let DiceTray: typeof import("./DiceTray.js").DiceTray;
let PlayMode: typeof import("../play/PlayMode.js").PlayMode;
beforeAll(async () => {
  ({ fireEvent, render, waitFor } = await import("@testing-library/react"));
  ({ DicePanel } = await import("./DicePanel.js"));
  ({ DiceTray } = await import("./DiceTray.js"));
  ({ PlayMode } = await import("../play/PlayMode.js"));
});

const definitions: DiceDefinitionsResponse = {
  scripts: [
    {
      scriptId: "script_1",
      scriptLabel: "Fate",
      scriptRevision: 2,
      checks: [
        {
          id: "fate",
          label: "Fate check",
          notation: "1d20",
          actors: ["persona", "character"],
          resolution: "strict",
          faceShape: "d20",
          help: "Roll when the outcome is uncertain.",
        },
      ],
    },
  ],
};

function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  return {
    rollId: "dice_roll_1" as DiceRollSnapshot["rollId"],
    requestId: "request_1",
    actor: { actorType: "character", actorId: "char_1", actorLabel: "Hero" },
    scriptId: "script_1",
    scriptLabel: "Fate",
    scriptRevision: 2,
    checkId: "fate",
    checkLabel: "Fate check",
    notation: "1d20",
    faceShape: "d20",
    resolution: "strict",
    mode: "normal",
    included: true,
    finalAttemptId: "attempt_1",
    attempts: [{ attemptId: "attempt_1", faces: [17], modifier: 2, subtotal: 17, total: 19 }],
    final: { total: 19, outcome: "Favorable", constraint: "Take the opening" },
    createdAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function lanes(normal: DiceRollSnapshot[] = [], immersive: DiceRollSnapshot[] = []) {
  return {
    normal: { revision: 3, rolls: normal },
    immersive: { revision: 5, rolls: immersive },
  };
}

beforeEach(() => {
  mocks.activeChat = {
    id: "chat_1",
    characterId: "char_1",
    insightsConfig: { diceEnabled: true, diceMode: "normal" },
  };
  mocks.activeBranch = { id: "branch_1" };
  mocks.character = { id: "char_1", name: "Hero" };
  mocks.persona = { id: "persona_1", name: "Player" };
  mocks.definitions = definitions;
  mocks.lanes = lanes();
  mocks.rolling = false;
  mocks.lastError = null;
  mocks.mobile = false;
  for (const action of Object.values(mocks.actions)) action.mockClear();
});

describe("DicePanel", () => {
  it("renders zero composer DOM while Dice is disabled", () => {
    mocks.activeChat = {
      id: "chat_1",
      characterId: "char_1",
      insightsConfig: { diceEnabled: false, diceMode: "normal" },
    };
    const { container } = render(<DicePanel />);
    expect(container.firstElementChild).toBeNull();
  });

  it("renders the centered compact states from the active lane", () => {
    mocks.lanes = lanes([makeRoll()]);
    const { container, getByText, rerender } = render(<DicePanel />);
    expect(getByText("dice_panel_ready:1")).toBeTruthy();
    expect(container.firstElementChild?.getAttribute("class")).toContain("left-1/2");
    expect(container.firstElementChild?.getAttribute("class")).toContain("-translate-x-1/2");

    mocks.activeChat = {
      id: "chat_1",
      characterId: "char_1",
      insightsConfig: { diceEnabled: true, diceMode: "immersive" },
    };
    mocks.lanes = lanes([], [makeRoll({
      mode: "immersive",
      policy: "choose",
      finalAttemptId: null,
      attempts: [
        { attemptId: "attempt_1", faces: [5], modifier: 0, subtotal: 5, total: 5 },
        { attemptId: "attempt_2", faces: [16], modifier: 0, subtotal: 16, total: 16 },
      ],
    })]);
    rerender(<DicePanel />);
    expect(getByText("dice_panel_choose_required")).toBeTruthy();

    mocks.rolling = true;
    rerender(<DicePanel />);
    expect(getByText("dice_panel_rolling")).toBeTruthy();
  });

  it("uses BottomSheet on mobile while keeping the same DiceTray content", () => {
    mocks.mobile = true;
    const { getByRole, getByTestId, getByText } = render(<DicePanel />);
    fireEvent.click(getByRole("button", { name: "dice_panel_title" }));
    expect(getByTestId("bottom-sheet")).toBeTruthy();
    expect(getByText("dice_tray_mode_normal")).toBeTruthy();
  });
});

describe("DiceTray", () => {
  it("hides the persona button when no persona is loaded and rolls for character", async () => {
    mocks.persona = null;
    const { queryByTestId, getByTestId } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={definitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={null}
        diceActorBindings={null}
      />,
    );
    // No persona loaded → no persona roll button; the character button remains.
    expect(queryByTestId("roll-btn-persona-fate")).toBeNull();
    fireEvent.click(getByTestId("roll-btn-character-fate"));
    await waitFor(() => expect(mocks.actions.roll).toHaveBeenCalledWith("chat_1", "branch_1", {
      scriptId: "script_1",
      checkId: "fate",
      actorType: "character",
      actorId: "char_1",
      mode: "normal",
    }));
  });

  it("supports Normal remove and clear actions", async () => {
    const roll = makeRoll();
    const { getByRole } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={definitions}
        lane={lanes([roll]).normal}
        character={mocks.character}
        persona={mocks.persona}
        diceActorBindings={null}
      />,
    );

    fireEvent.click(getByRole("button", { name: "dice_remove_roll" }));
    fireEvent.click(getByRole("button", { name: "dice_clear_lane" }));
    await waitFor(() => {
      expect(mocks.actions.removeRoll).toHaveBeenCalledWith("chat_1", "branch_1", roll.rollId);
      expect(mocks.actions.clearLane).toHaveBeenCalledWith("chat_1", "branch_1");
    });
  });

  it("supports Immersive include/undo and choose finalization", async () => {
    const roll = makeRoll({
      mode: "immersive",
      policy: "choose",
      retryReason: "Lucky",
      finalAttemptId: null,
      attempts: [
        { attemptId: "attempt_1", faces: [4], modifier: 0, subtotal: 4, total: 4 },
        { attemptId: "attempt_2", faces: [18], modifier: 0, subtotal: 18, total: 18, grantReason: "Lucky" },
      ],
      final: undefined,
    });
    const props = {
      chatId: "chat_1",
      branchId: "branch_1",
      mode: "immersive" as const,
      definitions,
      lane: lanes([], [roll]).immersive,
      character: mocks.character,
      persona: mocks.persona,
      diceActorBindings: null as Record<string, ("persona" | "character")[]> | null,
    };
    const { getAllByRole, getByRole, rerender } = render(<DiceTray {...props} />);

    fireEvent.click(getAllByRole("button", { name: "dice_choose_attempt" })[1]);
    fireEvent.click(getByRole("button", { name: "dice_exclude_roll" }));
    await waitFor(() => {
      expect(mocks.actions.chooseAttempt).toHaveBeenCalledWith("chat_1", "branch_1", roll.rollId, "attempt_2");
      expect(mocks.actions.setIncluded).toHaveBeenCalledWith("chat_1", "branch_1", roll.rollId, false);
    });

    rerender(<DiceTray {...props} lane={lanes([], [{ ...roll, included: false }]).immersive} />);
    fireEvent.click(getByRole("button", { name: "dice_include_roll" }));
    await waitFor(() => expect(mocks.actions.setIncluded).toHaveBeenLastCalledWith("chat_1", "branch_1", roll.rollId, true));
  });

  it("labels all four Immersive finalization policies", () => {
    const immersiveRolls = (["replace", "keep_best", "keep_worst", "choose"] as const).map((policy, index) => makeRoll({
      rollId: `dice_roll_${index + 1}` as DiceRollSnapshot["rollId"],
      mode: "immersive",
      policy,
      finalAttemptId: policy === "choose" ? null : "attempt_1",
    }));
    const { getByText } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="immersive"
        definitions={definitions}
        lane={lanes([], immersiveRolls).immersive}
        character={mocks.character}
        persona={mocks.persona}
        diceActorBindings={null}
      />,
    );
    expect(getByText("dice_policy_replace")).toBeTruthy();
    expect(getByText("dice_policy_keep_best")).toBeTruthy();
    expect(getByText("dice_policy_keep_worst")).toBeTruthy();
    expect(getByText("dice_policy_choose")).toBeTruthy();
  });

  it("keeps stale actor rolls actionable even when no current actor supports a check", async () => {
    const personaOnlyDefinitions: DiceDefinitionsResponse = {
      scripts: [{ ...definitions.scripts[0], checks: [{ ...definitions.scripts[0].checks[0], actors: ["persona"] }] }],
    };
    const stale = makeRoll({
      mode: "immersive",
      actor: { actorType: "persona", actorId: "persona_old", actorLabel: "Old persona" },
    });
    const { getByRole, getByText } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="immersive"
        definitions={personaOnlyDefinitions}
        lane={lanes([], [stale]).immersive}
        character={mocks.character}
        persona={null}
        diceActorBindings={null}
      />,
    );
    expect(getByText("dice_no_actor_title")).toBeTruthy();
    expect(getByText("dice_stale_actor_group")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "dice_remove_roll" }));
    await waitFor(() => expect(mocks.actions.removeRoll).toHaveBeenCalledWith("chat_1", "branch_1", stale.rollId));
  });

  // ── Per-check dual buttons + actor binding (Rework R3) ─────────────────────

  const twoCheckDefinitions: DiceDefinitionsResponse = {
    scripts: [
      {
        scriptId: "script_1",
        scriptLabel: "Fate",
        scriptRevision: 2,
        checks: [
          { id: "fate", label: "Fate check", notation: "1d20", actors: ["persona", "character"], resolution: "strict", faceShape: "d20", help: "Uncertain outcome." },
          { id: "stealth", label: "Stealth check", notation: "1d20", actors: ["persona", "character"], resolution: "strict", faceShape: "d20", help: "Sneaking." },
        ],
      },
    ],
  };

  it("renders an independent roll button per check (no shared selector) and rolls the targeted one", async () => {
    const { getByTestId } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={twoCheckDefinitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={null}
        diceActorBindings={null}
      />,
    );
    // Each check exposes its own character roll button — no actor selector,
    // no persistent single-check selection.
    expect(getByTestId("roll-btn-character-fate")).toBeTruthy();
    expect(getByTestId("roll-btn-character-stealth")).toBeTruthy();
    fireEvent.click(getByTestId("roll-btn-character-stealth"));
    await waitFor(() => expect(mocks.actions.roll).toHaveBeenCalledWith("chat_1", "branch_1", {
      scriptId: "script_1",
      checkId: "stealth",
      actorType: "character",
      actorId: "char_1",
      mode: "normal",
    }));
  });

  it("reflects per-check roll state on each actor button (idle vs reroll)", () => {
    const rolled = makeRoll({ checkId: "fate", checkLabel: "Fate check" });
    const { getByTestId } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={twoCheckDefinitions}
        lane={lanes([rolled]).normal}
        character={mocks.character}
        persona={null}
        diceActorBindings={null}
      />,
    );
    // The rolled check's button is in reroll state; the other is idle.
    expect(getByTestId("roll-btn-character-fate").getAttribute("aria-label")).toContain("dice_reroll");
    expect(getByTestId("roll-btn-character-stealth").getAttribute("aria-label")).toContain("dice_roll");
  });

  it("hides the character button when the chat binding narrows the script to persona", () => {
    // The check declares BOTH actors, but the chat binding removes character.
    const { queryByTestId, getByTestId } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={definitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={mocks.persona}
        diceActorBindings={{ script_1: ["persona"] }}
      />,
    );
    expect(getByTestId("roll-btn-persona-fate")).toBeTruthy();
    expect(queryByTestId("roll-btn-character-fate")).toBeNull();
  });

  it("shows the character button when the chat binding expands a persona-only check", () => {
    const personaOnlyDefinitions: DiceDefinitionsResponse = {
      scripts: [{ ...definitions.scripts[0], checks: [{ ...definitions.scripts[0].checks[0], actors: ["persona"] }] }],
    };
    // Declared persona-only, but the chat binding adds character (full freedom).
    const { getByTestId } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={personaOnlyDefinitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={mocks.persona}
        diceActorBindings={{ script_1: ["persona", "character"] }}
      />,
    );
    expect(getByTestId("roll-btn-character-fate")).toBeTruthy();
  });

  it("uses the wide two-region layout on desktop and the stacked layout on mobile", () => {
    const props = {
      chatId: "chat_1",
      branchId: "branch_1",
      mode: "normal" as const,
      definitions: twoCheckDefinitions,
      lane: lanes().normal,
      character: mocks.character,
      persona: null as { id: string; name: string } | null,
      diceActorBindings: null as Record<string, ("persona" | "character")[]> | null,
    };
    // Desktop: checks (left) + persona|character results (right).
    mocks.mobile = false;
    const { container, rerender } = render(<DiceTray {...props} />);
    expect(container.querySelector('[data-dice-layout="wide"]')).toBeTruthy();
    expect(container.querySelector('[data-dice-layout="narrow"]')).toBeNull();

    // Mobile: checks sticky on top, results scroll underneath.
    mocks.mobile = true;
    rerender(<DiceTray {...props} />);
    expect(container.querySelector('[data-dice-layout="narrow"]')).toBeTruthy();
    expect(container.querySelector('[data-dice-layout="wide"]')).toBeNull();
    mocks.mobile = false;
  });

  it("breaks list-shaped check help into one line per clause and leaves prose untouched", () => {
    const helpDefinitions: DiceDefinitionsResponse = {
      scripts: [{
        ...definitions.scripts[0],
        checks: [
          { ...definitions.scripts[0].checks[0], help: "Fate d20: 1 critical setback, 2-7 setback, 8-13 mixed, 14-19 favorable, 20 critical opportunity." },
          { ...definitions.scripts[0].checks[0], id: "prose", label: "Prose check", help: "Roll when the outcome is uncertain." },
        ],
      }],
    };
    const { getByText } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={helpDefinitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={mocks.persona}
        diceActorBindings={null}
      />,
    );
    // The flattened outcome table splits: lead-in, then range + outcome per line.
    expect(getByText("Fate d20")).toBeTruthy();
    for (const [range, outcome] of [["1", "critical setback"], ["2-7", "setback"], ["8-13", "mixed"], ["14-19", "favorable"], ["20", "critical opportunity"]]) {
      const outcomeEl = getByText(outcome);
      expect(outcomeEl.previousElementSibling?.textContent).toBe(range);
    }
    // Prose help is not list-shaped — it renders verbatim, trailing period included.
    expect(getByText("Roll when the outcome is uncertain.")).toBeTruthy();
  });

  it("does not replay a roll animation when the same lane snapshot rerenders", () => {
    const roll = makeRoll();
    const props = {
      chatId: "chat_1",
      branchId: "branch_1",
      mode: "normal" as const,
      definitions,
      lane: lanes([roll]).normal,
      character: mocks.character,
      persona: mocks.persona,
      diceActorBindings: null as Record<string, ("persona" | "character")[]> | null,
    };
    const { container, rerender } = render(<DiceTray {...props} />);
    expect(container.querySelectorAll(".dice-settle").length).toBeGreaterThan(0);
    // The class survives a mid-animation lane rerender (regression: it used to
    // be stripped, so the user never saw motion). After the animation ends, a
    // further rerender with the same rollKey must not re-add it (no replay).
    const wrapper = container.querySelector(".dice-settle");
    if (wrapper === null) throw new Error("Expected DiceTray to render a settle marker");
    fireEvent.animationEnd(wrapper);
    rerender(<DiceTray {...props} lane={{ ...props.lane }} />);
    expect(container.querySelectorAll(".dice-settle")).toHaveLength(0);
  });
});

describe("DicePanel docked", () => {
  it("renders without the absolute-centering wrapper when docked", () => {
    const { container } = render(<DicePanel docked />);
    // docked: no absolute positioning wrapper — the pill is a direct child.
    expect(container.firstElementChild?.getAttribute("class") ?? "").not.toContain("absolute");
    expect(container.querySelector('button[aria-label="dice_panel_title"]')).not.toBeNull();
  });

  it("default (not docked) keeps the absolute-centering wrapper", () => {
    const { container } = render(<DicePanel />);
    expect(container.firstElementChild?.getAttribute("class") ?? "").toContain("left-1/2");
  });
});

describe("PlayMode composer stack", () => {
  it("mounts Dice and the Experience launcher as siblings in a shared bar", () => {
	const { getByTestId, getByRole } = render(<PlayMode />);
	const wrapper = getByTestId("queue-manager").parentElement;
	if (wrapper === null) throw new Error("missing wrapper");
	// Wrapper children: QueueManager, the shared launcher bar, InputArea.
	expect(Array.from(wrapper.children)).toHaveLength(3);
	expect(wrapper.children[0]).toBe(getByTestId("queue-manager"));
	expect(wrapper.children[2]).toBe(getByTestId("input-area"));
	// The shared bar contains the Dice pill (coexistence: the Experience
	// launcher renders null with no config, but its sibling slot remains).
	const sharedBar = wrapper.children[1];
	expect(sharedBar.querySelector('button[aria-label="dice_panel_title"]')).not.toBeNull();
  });
});
