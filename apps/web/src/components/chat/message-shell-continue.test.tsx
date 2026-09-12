/**
 * LS-4a — the Continue affordance in MessageShell's action rows.
 *
 * WHAT THIS PROVES
 *   - Desktop: an ICON-ONLY button (no label text) next to the Edit action,
 *     tooltip/aria-label carried by the i18n key, on the last AI reply only —
 *     rendered when `canContinue` + `onContinue`, absent otherwise, and
 *     inert while busy.
 *   - The click wires through to `onContinue` (the controller's
 *     handleContinueMessage boundary).
 */
import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => false,
}));

const { MessageShell } = await import("./MessageShell.js");
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const Tooltip = await import("@radix-ui/react-tooltip");
const TooltipProvider = (Tooltip as unknown as { Provider: React.ComponentType<{ children: React.ReactNode }> }).Provider ?? (Tooltip as unknown as { TooltipProvider: React.ComponentType<{ children: React.ReactNode }> }).TooltipProvider ?? (({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children));

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
    } as never,
    copied: false,
    slotExtras: {},
    variantControlsOverlay: null,
    variantControlsRef: { current: null } as never,
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
  } as never;
}

function renderShell(props: Parameters<typeof MessageShell>[0]) {
  return render(React.createElement(TooltipProvider as never, null, React.createElement(MessageShell, props)));
}

describe("MessageShell — Continue button (LS-4a)", () => {
  test("renders icon-only next to Edit with tooltip aria-label when canContinue + onContinue", () => {
    const container = renderShell(makeProps({
      canContinue: true,
      actions: { ...makeProps().actions, onContinue: () => {} },
    }));
    const btn = container.container.querySelector('[data-testid="desktop-continue-btn"]');
    expect(btn).not.toBeNull();
    // Icon-only: no label text inside the button.
    expect(btn?.textContent ?? "").toBe("");
    // Tooltip contract: aria-label carries the i18n tooltip key.
    expect(btn?.getAttribute("aria-label")).toBe("continue_tooltip");
    // Positioned next to Edit: the Edit span is the button's previous sibling.
    const editSpan = btn?.previousElementSibling;
    expect(editSpan?.tagName).toBe("SPAN");
    expect(editSpan?.textContent).toContain("edit");
    cleanup();
  });

  test("absent without canContinue (non-last reply / capability off)", () => {
    const container = renderShell(makeProps({
      canContinue: false,
      actions: { ...makeProps().actions, onContinue: () => {} },
    }));
    expect(container.container.querySelector('[data-testid="desktop-continue-btn"]')).toBeNull();
    cleanup();
  });

  test("absent without onContinue even when canContinue", () => {
    const container = renderShell(makeProps({ canContinue: true }));
    expect(container.container.querySelector('[data-testid="desktop-continue-btn"]')).toBeNull();
    cleanup();
  });

  test("click invokes onContinue; busy disables the button", () => {
    let clicked = 0;
    const container = renderShell(makeProps({
      canContinue: true,
      actions: { ...makeProps().actions, onContinue: () => { clicked += 1; } },
    }));
    const btn = container.container.querySelector('[data-testid="desktop-continue-btn"]') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(clicked).toBe(1);

    cleanup();
    const busy = renderShell(makeProps({
      canContinue: true,
      isBusy: true,
      actions: { ...makeProps().actions, onContinue: () => { clicked += 1; } },
    }));
    const busyBtn = busy.container.querySelector('[data-testid="desktop-continue-btn"]') as HTMLButtonElement;
    expect(busyBtn?.disabled).toBe(true);
    busyBtn?.click();
    expect(clicked).toBe(1);
    cleanup();
  });
});
