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

describe("MessageShell annotate button (TPE-14)", () => {
  test("renders on greetings (canAiAnnotate + onAiAnnotate), hidden otherwise", async () => {
    const withAnnotate = renderWithTooltip(React.createElement(MessageShell, makeProps({
      canAiAnnotate: true,
      actions: { ...makeProps().actions, onAiAnnotate: () => {} },
    })));
    const btn = withAnnotate.container.querySelector('[data-testid="desktop-annotate-btn"]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("message_ai_editor_mode_annotate");
    cleanup();

    const withoutAnnotate = renderWithTooltip(React.createElement(MessageShell, makeProps()));
    expect(withoutAnnotate.container.querySelector('[data-testid="desktop-annotate-btn"]')).toBeNull();
    cleanup();
  });

  test("canAiAnnotate without a handler renders nothing (sibling shells pass no callback)", async () => {
    const { container } = renderWithTooltip(React.createElement(MessageShell, makeProps({ canAiAnnotate: true })));
    expect(container.querySelector('[data-testid="desktop-annotate-btn"]')).toBeNull();
    cleanup();
  });

  test("click fires onAiAnnotate", async () => {
    const onAiAnnotate = mock(() => {});
    const { container } = renderWithTooltip(React.createElement(MessageShell, makeProps({
      canAiAnnotate: true,
      actions: { ...makeProps().actions, onAiAnnotate },
    })));
    const btn = container.querySelector('[data-testid="desktop-annotate-btn"]') as HTMLElement;
    fireEvent.click(btn);
    expect(onAiAnnotate).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("AI-edit button path unchanged: renders on canAiEdit without annotate props", async () => {
    const { container } = renderWithTooltip(React.createElement(MessageShell, makeProps({
      isGreeting: false,
      canAiEdit: true,
    })));
    // No annotate button…
    expect(container.querySelector('[data-testid="desktop-annotate-btn"]')).toBeNull();
    cleanup();
  });
});
