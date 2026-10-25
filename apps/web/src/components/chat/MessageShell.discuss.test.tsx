/**
 * SC-18 — «Discuss in the sidechat» entry in MessageShell's action rows.
 *
 * Pins, through the real MessageShell + the real DiscussInSidechatMenu:
 *   - the entry renders (both rows) only with canDiscussInSidechat AND the
 *     onDiscussInSidechat callback — sibling shells passing neither render
 *     nothing;
 *   - one variant attaches at once (a direct press, no choice);
 *   - several variants open the choice (desktop popover / mobile sheet) with
 *     the two owner-settled options, and each option reports its scope.
 *
 * The mock surface mirrors MessageShell.annotate.test.tsx (key-echo i18n,
 * TooltipProvider) + the per-test flippable useIsMobile mock from
 * message-ai-editor-controls.test.tsx.
 */
import { describe, expect, test, mock, beforeEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const useIsMobile = mock(() => false);
installI18nContextSeam();

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile,
}));

const { MessageShell } = await import("./MessageShell.js");
const { fireEvent, render, cleanup } = await import("@testing-library/react");
const Tooltip = await import("@radix-ui/react-tooltip");
const TooltipProvider: React.ComponentType<{ children: React.ReactNode }> = (Tooltip as unknown as { Provider: React.ComponentType<{ children: React.ReactNode }> }).Provider ?? (Tooltip as unknown as { TooltipProvider: React.ComponentType<{ children: React.ReactNode }> }).TooltipProvider ?? (({ children }: { children: React.ReactNode }) => <>{children}</>);

const TOOLTIP_KEY = "discuss_in_sidechat_tooltip";
const SELECTED_KEY = "discuss_in_sidechat_selected";
const ALL_KEY = "discuss_in_sidechat_all";

function makeProps(overrides: Partial<Parameters<typeof MessageShell>[0]> = {}): Parameters<typeof MessageShell>[0] {
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

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function discussProps(variantCount: number, onDiscussInSidechat: (scope: "selected" | "all") => void) {
  return makeProps({
    canDiscussInSidechat: true,
    variantCount,
    actions: { ...makeProps().actions, onDiscussInSidechat },
  });
}

beforeEach(() => {
  useIsMobile.mockReset();
  useIsMobile.mockReturnValue(false);
});

describe("MessageShell discuss-in-sidechat entry (SC-18)", () => {
  test("desktop: renders the icon trigger with the tooltip label when allowed", () => {
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const { baseElement } = renderWithTooltip(React.createElement(MessageShell, discussProps(1, onDiscussInSidechat)));
    const trigger = baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe(TOOLTIP_KEY);
    cleanup();
  });

  test("desktop: renders nothing without the flag or without the callback (sibling shells)", () => {
    const flagged = renderWithTooltip(React.createElement(MessageShell, makeProps({ canDiscussInSidechat: true })));
    expect(flagged.baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]')).toBeNull();
    cleanup();

    const unflaggedOnDiscuss = mock((_scope: "selected" | "all") => {});
    const unflagged = renderWithTooltip(React.createElement(MessageShell, makeProps({
      actions: { ...makeProps().actions, onDiscussInSidechat: unflaggedOnDiscuss },
    })));
    expect(unflagged.baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]')).toBeNull();
    cleanup();
  });

  test("desktop: one variant attaches at once (no choice)", () => {
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, discussProps(1, onDiscussInSidechat)));
    fireEvent.click(view.baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]') as HTMLElement);
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("selected");
    // No choice opens for a single variant.
    expect(view.baseElement.querySelector('[data-testid="discuss-scope-all"]')).toBeNull();
    cleanup();
  });

  test("desktop: several variants open the popover choice, each option reports its scope", async () => {
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, discussProps(3, onDiscussInSidechat)));
    fireEvent.click(view.baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]') as HTMLElement);

    const selected = await view.findByTestId("discuss-scope-selected");
    const all = await view.findByTestId("discuss-scope-all");
    expect(selected.textContent).toContain(SELECTED_KEY);
    expect(all.textContent).toContain(ALL_KEY);

    fireEvent.click(all);
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("all");
    cleanup();

    const view2 = renderWithTooltip(React.createElement(MessageShell, discussProps(3, onDiscussInSidechat)));
    fireEvent.click(view2.baseElement.querySelector('[data-testid="discuss-sidechat-trigger"]') as HTMLElement);
    fireEvent.click(await view2.findByTestId("discuss-scope-selected"));
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(2);
    expect(onDiscussInSidechat.mock.calls[1]?.[0]).toBe("selected");
    cleanup();
  });

  // SC-18c (owner 2026-10-21): the mobile row no longer carries the discuss
  // trigger — the entry lives in the "..." sheet. Was: the icon row attached
  // at once. Now: the sheet item attaches at once, with no chooser.
  test("mobile: one variant attaches at once from the sheet item (no row trigger)", () => {
    useIsMobile.mockReturnValue(true);
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, discussProps(1, onDiscussInSidechat)));
    expect(view.container.querySelector('[data-testid="discuss-sidechat-trigger"]'), "no row trigger on mobile").toBeNull();
    fireEvent.click(view.container.querySelector('[data-testid="mobile-actions-menu-btn"]') as HTMLElement);
    const popup = document.querySelector(".bs-popup") as HTMLElement;
    const item = [...popup.querySelectorAll("button")].find((b) => b.textContent === TOOLTIP_KEY) as HTMLElement;
    fireEvent.click(item);
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("selected");
    expect(view.baseElement.querySelector('[data-testid="discuss-scope-all"]'), "no chooser for a single variant").toBeNull();
    cleanup();
  });

  // SC-18c: was the row trigger opening the choice sheet. Now the "..."
  // sheet item opens the scope chooser after the action sheet closes.
  test("mobile: several variants open the chooser from the sheet item", async () => {
    useIsMobile.mockReturnValue(true);
    const onDiscussInSidechat = mock((_scope: "selected" | "all") => {});
    const view = renderWithTooltip(React.createElement(MessageShell, discussProps(2, onDiscussInSidechat)));
    fireEvent.click(view.container.querySelector('[data-testid="mobile-actions-menu-btn"]') as HTMLElement);
    const popup = document.querySelector(".bs-popup") as HTMLElement;
    const item = [...popup.querySelectorAll("button")].find((b) => b.textContent === TOOLTIP_KEY) as HTMLElement;
    fireEvent.click(item);
    expect(onDiscussInSidechat, "the flow fires only after the chooser picks").not.toHaveBeenCalled();

    const all = await view.findByTestId("discuss-scope-all");
    expect(all.textContent).toContain(ALL_KEY);
    expect(await view.findByTestId("discuss-scope-selected")).not.toBeNull();
    fireEvent.click(all);
    expect(onDiscussInSidechat).toHaveBeenCalledTimes(1);
    expect(onDiscussInSidechat.mock.calls[0]?.[0]).toBe("all");
    cleanup();
  });
});
