import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

installI18nContextSeam();

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => false,
}));

const { MessageShell } = await import("./MessageShell.js");
const { render, cleanup } = await import("@testing-library/react");
const Tooltip = await import("@radix-ui/react-tooltip");
// @radix-ui/react-tooltip@1.4.1 exports `Provider` as a typed alias of
// TooltipProvider (index.d.ts:97) — the real export IS the provider, so the
// old multi-shape probe (Provider ?? TooltipProvider ?? passthrough) was dead
// defensive code against imagined package shapes. Read the typed export.
const TooltipProvider = Tooltip.Provider;

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

function renderWithTooltip(ui: React.ReactElement) {
  return render(React.createElement(TooltipProvider as never, null, ui));
}

describe("MessageShell narrate button", () => {
  test("renders when onNarrate provided, hidden when not", async () => {
    const withNarrate = renderWithTooltip(React.createElement(MessageShell, makeProps({ actions: { ...makeProps().actions, onNarrate: () => {} } })));
    expect(withNarrate.container.querySelector('[data-testid="desktop-narrate-btn"]')).not.toBeNull();
    cleanup();

    const withoutNarrate = renderWithTooltip(React.createElement(MessageShell, makeProps()));
    expect(withoutNarrate.container.querySelector('[data-testid="desktop-narrate-btn"]')).toBeNull();
    cleanup();
  });

  test("narrating=true renders stop icon (aria-label = narrate_stop_tooltip)", async () => {
    const { container } = renderWithTooltip(
      React.createElement(MessageShell, makeProps({ narrating: true, actions: { ...makeProps().actions, onNarrate: () => {} } } as never)),
    );
    const btn = container.querySelector('[data-testid="desktop-narrate-btn"]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("narrate_stop_tooltip");
    expect(btn?.className).toContain("animate-pulse");
    cleanup();
  });

  test("narrating=false renders speaker icon (aria-label = narrate_tooltip)", async () => {
    const { container } = renderWithTooltip(
      React.createElement(MessageShell, makeProps({ narrating: false, actions: { ...makeProps().actions, onNarrate: () => {} } } as never)),
    );
    const btn = container.querySelector('[data-testid="desktop-narrate-btn"]');
    expect(btn?.getAttribute("aria-label")).toBe("narrate_tooltip");
    expect(btn?.className).not.toContain("animate-pulse");
    cleanup();
  });
});
