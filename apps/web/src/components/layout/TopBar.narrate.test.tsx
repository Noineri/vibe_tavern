import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { wireTtsProfile } from "../../../test/wire-fixtures.js";
import type { VoiceMapData } from "../../lib/tts/voice-map-data.js";

useDomEnv();

installI18nContextSeam();

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => false,
}));

// Control voice-map data per test
let currentData: VoiceMapData | null = null;
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
// @radix-ui/react-tooltip@1.4.1 exports Provider as a TYPED ALIAS of
// TooltipProvider (dist/index.d.ts: `export { ..., TooltipProvider as Provider,
// ..., TooltipProvider, ... }`), so the old
// `Provider ?? TooltipProvider ?? passthrough` probe with its per-arm double
// casts was dead defensive code — the real export typechecks directly.
const TooltipProvider = Tooltip.Provider;
const Popover = await import("@radix-ui/react-popover");
const { TopBar } = await import("./TopBar.js");
const { useTtsPlaybackStore } = await import("../../stores/tts-playback-store.js");

function renderWithTooltip(ui: React.ReactElement) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(Popover.Root, null, ui),
    ),
  );
}

// Prevent TopBar's provider/preset hooks from fetching with null baseUrl in
// happy-dom. Typed against the real fetch surface (the required `preconnect`
// member rides along from the captured original — the whisper-worker shape),
// so no erasure is needed on the install.
const realFetch = globalThis.fetch;

beforeEach(() => {
  useTtsPlaybackStore.setState({ autoNarrate: false, narrations: {}, rate: 1 });
  currentData = null;
  globalThis.fetch = Object.assign(
    mock(async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })),
    { preconnect: realFetch.preconnect },
  );
  cleanup();
});

afterAll(() => {
  // R3: the fetch double is restored after the last test — the captured
  // original (dom-env's network guard) is the process-wide state again.
  globalThis.fetch = realFetch;
});

describe("TopBar auto-narrate toggle", () => {
  test("hidden when no TTS profiles exist", async () => {
    currentData = { profiles: [], links: [] };
    const { container } = renderWithTooltip(React.createElement(TopBar, { update: null }));
    expect(container.querySelector('[data-testid="topbar-autonarrate-toggle"]')).toBeNull();
  });

  test("visible when profiles exist and flips autoNarrate", async () => {
    currentData = { profiles: [wireTtsProfile({ id: "p1" })], links: [] };
    const { container } = renderWithTooltip(React.createElement(TopBar, { update: null }));
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
