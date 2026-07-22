import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DiceDefinitionsResponse, DiceLaneState, DiceRollSnapshot } from "../../api/types.js";
import { DicePanel } from "./DicePanel.js";
import { DiceTray } from "./DiceTray.js";
import { PlayMode } from "../play/PlayMode.js";

const mocks = vi.hoisted(() => ({
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
    setScope: vi.fn(),
    roll: vi.fn().mockResolvedValue("request_1"),
    removeRoll: vi.fn().mockResolvedValue(undefined),
    clearLane: vi.fn().mockResolvedValue(undefined),
    setIncluded: vi.fn().mockResolvedValue(undefined),
    chooseAttempt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../i18n/context.js", () => ({
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

vi.mock("../../hooks/use-mobile.js", () => ({
  useIsMobile: () => mocks.mobile,
}));

vi.mock("../../stores/snapshot-store.js", () => ({
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

vi.mock("../../stores/dice-store.js", () => {
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

vi.mock("../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../shared/BottomSheet.js", () => ({
  BottomSheet: ({ open, title, children }: { open: boolean; title?: ReactNode; children: ReactNode }) =>
    open ? <div data-testid="bottom-sheet">{title}{children}</div> : null,
}));

vi.mock("./QueueManager.js", () => ({ QueueManager: () => <div data-testid="queue-manager" /> }));
vi.mock("./InputArea.js", () => ({ InputArea: () => <div data-testid="input-area" /> }));
vi.mock("./MessageList.js", () => ({ MessageList: () => <div data-testid="message-list" /> }));
vi.mock("./MessageAiEditorModal.js", () => ({ MessageAiEditorModal: () => null }));

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

afterEach(() => {
  cleanup();
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
  it("disables a missing persona actor and rolls for the character", async () => {
    mocks.persona = null;
    const { getByRole } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="normal"
        definitions={definitions}
        lane={lanes().normal}
        character={mocks.character}
        persona={null}
      />,
    );

    expect(getByRole("radio", { name: "dice_actor_persona" }).getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "dice_roll_check:Fate check" }));
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
    const { getAllByRole, getByRole, rerender } = render(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="immersive"
        definitions={definitions}
        lane={lanes([], [roll]).immersive}
        character={mocks.character}
        persona={mocks.persona}
      />,
    );

    fireEvent.click(getAllByRole("button", { name: "dice_choose_attempt" })[1]);
    fireEvent.click(getByRole("button", { name: "dice_exclude_roll" }));
    await waitFor(() => {
      expect(mocks.actions.chooseAttempt).toHaveBeenCalledWith("chat_1", "branch_1", roll.rollId, "attempt_2");
      expect(mocks.actions.setIncluded).toHaveBeenCalledWith("chat_1", "branch_1", roll.rollId, false);
    });

    rerender(
      <DiceTray
        chatId="chat_1"
        branchId="branch_1"
        mode="immersive"
        definitions={definitions}
        lane={lanes([], [{ ...roll, included: false }]).immersive}
        character={mocks.character}
        persona={mocks.persona}
      />,
    );
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
      />,
    );
    expect(getByText("dice_no_actor_title")).toBeTruthy();
    expect(getByText("dice_stale_actor_group")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "dice_remove_roll" }));
    await waitFor(() => expect(mocks.actions.removeRoll).toHaveBeenCalledWith("chat_1", "branch_1", stale.rollId));
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
    };
    const { container, rerender } = render(<DiceTray {...props} />);
    expect(container.querySelectorAll(".dice-settle").length).toBeGreaterThan(0);
    rerender(<DiceTray {...props} lane={{ ...props.lane }} />);
    expect(container.querySelectorAll(".dice-settle")).toHaveLength(0);
  });
});

describe("PlayMode composer stack", () => {
  it("mounts DicePanel as a centered sibling between QueueManager and InputArea", () => {
    const { getByTestId, getByRole } = render(<PlayMode />);
    const wrapper = getByTestId("queue-manager").parentElement;
    expect(wrapper).not.toBeNull();
    expect(Array.from(wrapper?.children ?? [])).toEqual([
      getByTestId("queue-manager"),
      getByRole("button", { name: "dice_panel_title" }).parentElement,
      getByTestId("input-area"),
    ]);
  });
});
