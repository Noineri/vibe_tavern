/**
 * SC-18c — the mobile message action row fits its swipe switcher.
 *
 * Pins, through the real MessageShell (mobile viewport):
 *   - the assistant row renders EXACTLY the switcher at the start plus the
 *     right group (images + continue + regenerate) — branch, narrate, the AI
 *     editor, annotate, discuss and resend are gone from the row;
 *   - the right group never holds more than three 44px buttons (the budget
 *     assertion is the composition, not pixels);
 *   - the "..." sheet carries the moved actions (branch / narrate / AI
 *     editor / annotate / discuss, in row order, then copy / edit / delete)
 *     and each one still fires; continue left the sheet;
 *   - discuss with one variant attaches at once after the sheet closes, with
 *     several variants the scope chooser opens after the sheet closes;
 *   - user rows keep their existing controls (resend, branch).
 *
 * Basis (owner 2026-10-21): at 375 px the switcher alone needs 144 px, so
 * the row keeps images, continue and regenerate while the rest moves into
 * the "..." sheet; resend stays a user-message action.
 */
import { describe, expect, test, mock, beforeEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const useIsMobile = mock(() => true);
installI18nContextSeam();

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile,
}));

const { MessageShell } = await import("./MessageShell.js");
const { fireEvent, render, cleanup } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");

type ShellProps = Parameters<typeof MessageShell>[0];

function makeProps(overrides: Partial<ShellProps> = {}): ShellProps {
  return {
    messageId: "m1",
    chatId: "c1",
    role: "assistant",
    showSeparator: false,
    author: {
      name: "Test",
      avatarAssetId: null,
      avatarCropJson: null,
      avatarSrc: null,
    },
    isUser: false,
    isGreeting: false,
    isEditing: false,
    isGenerating: false,
    isBusy: false,
    canBranch: false,
    canRegenerate: false,
    canResend: false,
    canAiEdit: false,
    selectedVariantIndex: 0,
    variantCount: 1,
    canSwitchVariant: false,
    metaCtx: {
      chatId: "c1",
      messageId: "m1",
      messageRole: "assistant",
      variant: null,
      variantIndex: 0,
      isStreaming: false,
      isCoauthorTurn: false,
      presetName: null,
      tokenCount: 0,
      createdAt: new Date().toISOString(),
      diceRolls: [],
    },
    copied: false,
    slotExtras: {},
    variantControlsOverlay: null,
    variantControlsRef: { current: null },
    children: React.createElement("div", null, "hello"),
    actions: {
      onCopy: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onBranch: () => {},
      onRegenerate: () => {},
      onResend: () => {},
      onAiEdit: () => {},
    },
    ...overrides,
  };
}

/** Every row affordance the assistant row can carry. */
function fullAssistantProps(overrides: Partial<ShellProps> = {}): ShellProps {
  const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
  return makeProps({
    canBranch: true,
    canRegenerate: true,
    canResend: true,
    canAiEdit: true,
    canAiAnnotate: true,
    canDiscussInSidechat: true,
    canContinue: true,
    canSwitchVariant: true,
    variantCount: 3,
    mobileVariantControls: React.createElement("span", { "data-testid": "switcher-stub" }, "1/3"),
    actions: {
      ...makeProps().actions,
      onContinue: () => {},
      onNarrate: () => {},
      onAiAnnotate: () => {},
      onDiscussInSidechat,
    },
    ...overrides,
  });
}

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** The mobile action grid (the only `mt-2 grid` in a text-message render). */
function rowGrid(container: HTMLElement): HTMLElement {
  const grid = container.querySelector(".mt-2.grid");
  expect(grid, "the mobile action grid must render").not.toBeNull();
  return grid as HTMLElement;
}

/** 44px row buttons = the budget unit (h-11 w-11 icon buttons). */
function wideButtons(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll("button")].filter(
    (b) => b.className.includes("h-11") && b.className.includes("w-11"),
  ) as HTMLElement[];
}

function openSheet(view: { container: HTMLElement; baseElement: HTMLElement }): HTMLElement {
  const trigger = view.container.querySelector('[data-testid="mobile-actions-menu-btn"]') as HTMLElement;
  expect(trigger, "the ... menu trigger must render").not.toBeNull();
  fireEvent.click(trigger);
  const popup = document.querySelector(".bs-popup") as HTMLElement;
  expect(popup, "the action sheet popup must open").not.toBeNull();
  return popup;
}

function sheetLabels(popup: HTMLElement): string[] {
  return [...popup.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((text) => text !== "cancel");
}

function clickSheetItem(popup: HTMLElement, label: string): void {
  const item = [...popup.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(item, `sheet item "${label}" must render`).toBeTruthy();
  fireEvent.click(item!);
}

beforeEach(() => {
  useIsMobile.mockReset();
  useIsMobile.mockReturnValue(true);
});

describe("SC-18c mobile assistant row — switcher + images + continue + regenerate", () => {
  test("the row holds exactly the switcher, images, continue and regenerate", () => {
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps()));
    const grid = rowGrid(view.container);

    // Present: the switcher stub at the row start (first cell), the real
    // image trigger, continue and regenerate.
    const stub = grid.querySelector('[data-testid="switcher-stub"]');
    expect(stub, "the switcher must render").not.toBeNull();
    expect(grid.children[0].contains(stub), "the switcher must sit in the row's first cell").toBe(true);
    expect(grid.querySelector('[data-testid="image-gen-message-trigger"]'), "images stay in the row").not.toBeNull();
    expect(grid.querySelector('[data-testid="mobile-continue-btn"]'), "continue joins the row").not.toBeNull();
    expect(grid.querySelector('[aria-label="regen"]'), "regenerate stays in the row").not.toBeNull();

    // Gone from the row: branch, narrate, AI editor, annotate, discuss, resend.
    expect(grid.querySelector('[aria-label="branch"]'), "branch leaves the row").toBeNull();
    expect(grid.querySelector('[data-testid="mobile-narrate-btn"]'), "narrate leaves the row").toBeNull();
    expect(grid.querySelector('[aria-label="message_ai_editor_tooltip"]'), "AI editor leaves the row").toBeNull();
    expect(grid.querySelector('[data-testid="mobile-annotate-btn"]'), "annotate leaves the row").toBeNull();
    expect(grid.querySelector('[data-testid="discuss-sidechat-trigger"]'), "discuss leaves the row").toBeNull();
    expect(grid.querySelector('[aria-label="resend"]'), "resend is a user action, not in the assistant row").toBeNull();
    cleanup();
  });

  test("budget: the right group never holds more than three 44px buttons", () => {
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps()));
    const buttons = wideButtons(rowGrid(view.container));
    expect(buttons.length, "images + continue + regenerate = exactly three 44px buttons").toBe(3);
    cleanup();

    const noContinue = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({ canContinue: false })));
    expect(wideButtons(rowGrid(noContinue.container)).length, "without continue the group shrinks to two").toBe(2);
    cleanup();
  });

  test("the right group clears the mobile rail's edge handle lane", () => {
    // The rail's grab handle owns the first 24px of the transcript's right
    // edge (scroll-rail.tsx: right-0 w-6). The row sits inside px-3 (12px),
    // so without pr-4 on the right cell the buttons' last ~12px fall under
    // the handle and taps meant for «регенерация» start a scrub instead
    // (owner report 2026-11-06). The budget assertion is the composition.
    const rightCell = (view: ReturnType<typeof renderWithTooltip>): HTMLElement => {
      const grid = rowGrid(view.container);
      return grid.children[grid.children.length - 1] as HTMLElement;
    };
    const assistant = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps()));
    expect(rightCell(assistant).className, "assistant right group keeps the pr-4 lane clearance").toContain("pr-4");
    cleanup();

    const user = renderWithTooltip(React.createElement(MessageShell, makeProps({
      role: "user",
      isUser: true,
      canBranch: true,
      canResend: true,
    })));
    expect(rightCell(user).className, "user right group keeps the same clearance").toContain("pr-4");
    cleanup();
  });

  test("continue fires from the row; busy disables it", () => {
    let clicked = 0;
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({
      actions: { ...makeProps().actions, onContinue: () => { clicked += 1; } },
    })));
    const btn = view.container.querySelector('[data-testid="mobile-continue-btn"]') as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("continue_tooltip");
    fireEvent.click(btn);
    expect(clicked).toBe(1);
    cleanup();

    const busy = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({
      isBusy: true,
      actions: { ...makeProps().actions, onContinue: () => { clicked += 1; } },
    })));
    const busyBtn = busy.container.querySelector('[data-testid="mobile-continue-btn"]') as HTMLButtonElement;
    expect(busyBtn.disabled).toBe(true);
    busyBtn.click();
    expect(clicked).toBe(1);
    cleanup();
  });
});

describe("SC-18c mobile sheet — moved actions fire, continue is gone", () => {
  test("the sheet lists branch, narrate, AI editor, annotate and discuss in row order, then copy/edit/delete", () => {
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps()));
    const popup = openSheet(view);
    expect(sheetLabels(popup)).toEqual([
      "branch",
      "narrate_action",
      "message_ai_editor_tooltip",
      "message_ai_editor_mode_annotate",
      "discuss_in_sidechat_tooltip",
      "copy",
      "edit",
      "delete",
    ]);
    cleanup();
  });

  test("each moved action fires from the sheet", () => {
    const onBranch = mock(() => {});
    const onNarrate = mock(() => {});
    const onAiEdit = mock(() => {});
    const onAiAnnotate = mock(() => {});
    const props = fullAssistantProps({
      canDiscussInSidechat: false,
      actions: {
        ...makeProps().actions,
        onBranch,
        onNarrate,
        onAiEdit,
        onAiAnnotate,
      },
    });

    const pairs: Array<[string, { (): void }]> = [
      ["branch", onBranch],
      ["narrate_action", onNarrate],
      ["message_ai_editor_tooltip", onAiEdit],
      ["message_ai_editor_mode_annotate", onAiAnnotate],
    ];
    for (const [label, fn] of pairs) {
      const view = renderWithTooltip(React.createElement(MessageShell, props));
      clickSheetItem(openSheet(view), label);
      expect(fn).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  test("discuss with one variant attaches at once after the sheet closes", () => {
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({
      variantCount: 1,
      actions: { ...makeProps().actions, onDiscussInSidechat },
    })));
    clickSheetItem(openSheet(view), "discuss_in_sidechat_tooltip");
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("selected");
    expect(view.baseElement.querySelector('[data-testid="discuss-scope-all"]'), "no chooser for a single variant").toBeNull();
    cleanup();
  });

  test("discuss with several variants opens the chooser after the sheet closes", async () => {
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({
      actions: { ...makeProps().actions, onDiscussInSidechat },
    })));
    clickSheetItem(openSheet(view), "discuss_in_sidechat_tooltip");
    expect(onDiscussInSidechat, "the flow fires only after the chooser picks").not.toHaveBeenCalled();

    const all = await view.findByTestId("discuss-scope-all");
    fireEvent.click(all);
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("all");
    cleanup();
  });
});

describe("SC-18c user rows keep their controls", () => {
  test("user row keeps resend and branch inline", () => {
    const view = renderWithTooltip(React.createElement(MessageShell, makeProps({
      role: "user",
      isUser: true,
      canBranch: true,
      canResend: true,
    })));
    const grid = rowGrid(view.container);
    expect(grid.querySelector('[aria-label="resend"]'), "resend stays a user-row action").not.toBeNull();
    expect(grid.querySelector('[aria-label="branch"]'), "branch stays on the user row").not.toBeNull();
    expect(grid.querySelector('[data-testid="mobile-continue-btn"]'), "no continue on user rows").toBeNull();
    cleanup();
  });
});

test("mobile regenerate and branch keep named themed hints and actions", async () => {
  const onRegenerate = mock();
  const assistant = renderWithTooltip(React.createElement(MessageShell, fullAssistantProps({ actions: { ...makeProps().actions, onRegenerate } })));
  const regen = assistant.getByRole("button", { name: "regen" });
  fireEvent.pointerMove(regen, { pointerType: "mouse" });
  expect((await assistant.findByRole("tooltip")).textContent).toBe("regen");
  fireEvent.click(regen);
  expect(onRegenerate).toHaveBeenCalledTimes(1);
  cleanup();
  const onBranch = mock();
  const user = renderWithTooltip(React.createElement(MessageShell, makeProps({ role: "user", isUser: true, canBranch: true, actions: { ...makeProps().actions, onBranch } })));
  const branch = user.getByRole("button", { name: "branch" });
  fireEvent.pointerMove(branch, { pointerType: "mouse" });
  expect((await user.findByRole("tooltip")).textContent).toBe("branch");
  fireEvent.click(branch);
  expect(onBranch).toHaveBeenCalledTimes(1);
  cleanup();
});
