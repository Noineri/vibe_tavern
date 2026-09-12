import { describe, expect, test, mock, beforeEach } from "bun:test";
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

// Control voice-map data per test
let currentData: { profiles: Array<{ id: string }>; links: unknown[] } | null = null;
const realVoiceMapData = await import("../../lib/tts/voice-map-data.js");
mock.module("../../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  useVoiceMapData: () => ({
    data: currentData,
    refresh: async () => {},
  }),
  refreshVoiceMapData: async () => {},
}));

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const Tooltip = await import("@radix-ui/react-tooltip");
const TooltipProvider = (Tooltip as unknown as { Provider: React.ComponentType<{ children: React.ReactNode }> }).Provider ?? (Tooltip as unknown as { TooltipProvider: React.ComponentType<{ children: React.ReactNode }> }).TooltipProvider ?? (({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children));
const Popover = await import("@radix-ui/react-popover");
const { TopBar } = await import("./TopBar.js");
const { useTtsPlaybackStore } = await import("../../stores/tts-playback-store.js");

function renderWithTooltip(ui: React.ReactElement) {
  return render(
    React.createElement(
      TooltipProvider as never,
      null,
      React.createElement((Popover as unknown as { Root: React.ComponentType<{ children: React.ReactNode }> }).Root as never, null, ui),
    ),
  );
}

beforeEach(() => {
  useTtsPlaybackStore.setState({ autoNarrate: false, narrations: {}, rate: 1 });
  currentData = null;
  // Prevent TopBar's provider/preset hooks from fetching with null baseUrl in happy-dom
  (globalThis as unknown as { fetch: unknown }).fetch = mock(async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })) as never;
  cleanup();
});

describe("TopBar auto-narrate toggle", () => {
  test("hidden when no TTS profiles exist", async () => {
    currentData = { profiles: [], links: [] };
    const { container } = renderWithTooltip(React.createElement(TopBar, { update: null } as never));
    expect(container.querySelector('[data-testid="topbar-autonarrate-toggle"]')).toBeNull();
  });

  test("visible when profiles exist and flips autoNarrate", async () => {
    currentData = { profiles: [{ id: "p1" } as never], links: [] };
    const { container } = renderWithTooltip(React.createElement(TopBar, { update: null } as never));
    const btn = container.querySelector('[data-testid="topbar-autonarrate-toggle"]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    expect(useTtsPlaybackStore.getState().autoNarrate).toBe(false);
    fireEvent.click(btn as Element);
    expect(useTtsPlaybackStore.getState().autoNarrate).toBe(true);
    // aria-pressed should now be true after re-render — need to query again
    // TopBar subscribes to store, so it should re-render
    const btnAfter = container.querySelector('[data-testid="topbar-autonarrate-toggle"]');
    expect(btnAfter?.getAttribute("aria-pressed")).toBe("true");
  });
});
