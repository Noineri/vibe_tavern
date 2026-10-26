import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

installI18nContextSeam();

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => true,
}));

const { MessageShell } = await import("./MessageShell.js");
const { fireEvent, render, cleanup } = await import("@testing-library/react");
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
    isGreeting: true,
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

function renderWithTooltip(ui: React.ReactElement) {
  return render(React.createElement(TooltipProvider as never, null, ui));
}

// SC-18c (owner 2026-10-21): annotate leaves the mobile row for the "..."
// sheet. Was: `mobile-annotate-btn` rendered in the row. Now: no row button;
// the sheet item carries the label and fires the action.
describe("MessageShell annotate entry — mobile sheet (TPE-14, SC-18c)", () => {
  test("no row button; the sheet item fires onAiAnnotate", async () => {
    let called = 0;
    const withAnnotate = renderWithTooltip(React.createElement(MessageShell, makeProps({
      canAiAnnotate: true,
      actions: { ...makeProps().actions, onAiAnnotate: () => { called += 1; } },
    })));
    expect(withAnnotate.container.querySelector('[data-testid="mobile-annotate-btn"]'), "no row button on mobile").toBeNull();

    const trigger = withAnnotate.container.querySelector('[data-testid="mobile-actions-menu-btn"]') as HTMLElement;
    expect(trigger, "the ... menu trigger must render").not.toBeNull();
    fireEvent.click(trigger);
    const popup = document.querySelector(".bs-popup") as HTMLElement;
    expect(popup, "the action sheet popup must open").not.toBeNull();
    const item = [...popup.querySelectorAll("button")].find((b) => b.textContent === "message_ai_editor_mode_annotate");
    expect(item, "the sheet carries the annotate entry").toBeTruthy();
    fireEvent.click(item!);
    expect(called).toBe(1);
    cleanup();

    const withoutAnnotate = renderWithTooltip(React.createElement(MessageShell, makeProps()));
    expect(withoutAnnotate.container.querySelector('[data-testid="mobile-annotate-btn"]')).toBeNull();
    cleanup();
  });
});
