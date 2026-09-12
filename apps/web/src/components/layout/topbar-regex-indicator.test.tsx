import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();
const { render } = await import("@testing-library/react");

/**
 * RX-14 (REGEX_EXTENSION_PLAN Wave 3): the TopBar global-regex indicator.
 *
 * Pins:
 *   - renders with the enabled-preset count when ≥1 active (enabled presets);
 *   - hidden when the resolution is empty or all presets are disabled;
 *   - fetch failure degrades silently (no indicator, no crash);
 *   - click opens the Prompt Manager (where regex presets are managed).
 *
 * Harness mirrors message-block-regex-display.test.ts: real TopBar mounted,
 * heavy out-of-graph modules mocked at the boundary; the regex API module is
 * mocked with the SAFE pattern (capture real exports, spread, override one).
 */

const NOOP = () => {};

const realI18nContext = await import("../../i18n/context.js");
const realRegexApi = await import("../../api/regex-api.js");
const realUsePresetController = await import("../../hooks/use-preset-controller.js");
const realUseProviderProfiles = await import("../../hooks/use-provider-profiles.js");
const realTooltip = await import("../shared/Tooltip.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
    // Minimal interpolation so assertions can match rendered tooltip text.
    const params = opts ?? {};
    const raw = {
      topbar_regex_active_one: "Regex active: {{name}}",
      topbar_regex_active_many: "Regex active: {{n}}",
    } as Record<string, string>;
    let out = raw[key] ?? key;
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{{${k}}}`, String(v));
    return out;
  }, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

mock.module("../../hooks/use-preset-controller.js", () => ({
  ...realUsePresetController,
  usePresetController: () => ({ handleSetActivePromptPresetId: async () => {} }),
}));

mock.module("../../hooks/use-provider-profiles.js", () => ({
  ...realUseProviderProfiles,
  useProviderProfiles: () => ({ activeProviderProfile: null }),
}));

// Presentational passthrough — no Radix TooltipProvider needed in the test DOM.
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// The interface-settings popover trigger renders inside Popover.Root far
// below in TopBar — stub the Radix surface to plain passthrough divs.
const realPopover = await import("@radix-ui/react-popover");
mock.module("@radix-ui/react-popover", () => ({
  ...realPopover,
  Root: ({ children }: { children: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// RX-14 seam under test — what the indicator counts. Overridden per test.
let mockResolvedPresets: Array<Record<string, unknown>> = [];
let mockResolveFails = false;
mock.module("../../api/regex-api.js", () => ({
  ...realRegexApi,
  resolveActiveRegexPresets: async () => {
    if (mockResolveFails) throw new Error("network down");
    return mockResolvedPresets as unknown as Awaited<ReturnType<typeof realRegexApi.resolveActiveRegexPresets>>;
  },
}));

beforeAll(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: NOOP, removeEventListener: NOOP,
      addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  }
});

beforeEach(async () => {
  // The display-preset cache is MODULE-level — every test starts clean.
  const { hook } = await loadModules();
  hook.invalidateActiveRegexPresets();
});

const TopBarModule = import("./TopBar.js");
const HookModule = import("../../hooks/use-active-regex-presets.js");

async function loadModules() {
  const [{ TopBar }, hook] = await Promise.all([
    TopBarModule as Promise<{ TopBar: React.ComponentType<Record<string, never>> }>,
    HookModule,
  ]);
  return { TopBar, hook };
}

function wirePreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rx_1",
    name: "Strip tags",
    findRegex: "/x/g",
    replaceString: "y",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Desktop TopBar (isMobile false via matchMedia shim) with the indicator slot. */
async function mountTopBar() {
  const { TopBar } = await loadModules();
  // Seed the snapshot store so useChatMeta resolves a characterId — without
  // it the indicator hook has no key and never fetches.
  const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
  const { useChatStore } = await import("../../stores/chat-store.js");
  useSnapshotStore.getState().ingestSnapshot({
    chats: [],
    allCharacters: [],
    messages: [],
    summaries: [],
    activeChat: {
      id: "chat-1",
      title: "Chat 1",
      characterId: "c1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    },
    character: {
      id: "c1",
      name: "Test Char",
      avatarExt: null,
      avatarFullExt: null,
      description: "",
      scenario: "",
      systemPrompt: "",
      subtitle: "",
      firstMessage: null,
      mesExample: null,
      mesExampleMode: "always",
      mesExampleDepth: 4,
      alternateGreetings: [],
      postHistoryInstructions: null,
      creatorNotes: null,
      depthPrompt: null,
      depthPromptDepth: null,
      depthPromptRole: null,
      tags: [],
      avatarAssetId: null,
      avatarFullAssetId: null,
      avatarCropJson: null,
      personalitySummary: null,
      includeGalleryInPrompt: false,
      includeAvatarInPrompt: false,
      avatarDescription: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    persona: null,
  } as unknown as import("../../app-client.js").AppSnapshot);
  useChatStore.getState().setActiveChatId("chat-1" as import("@vibe-tavern/domain").ChatId);
  const utils = render(<TopBar />);
  // Flush the async preset fetch so the indicator settles.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return utils;
}

describe("TopBar — RX-14 global-regex indicator", () => {
  test("renders the enabled count when regex presets are active", async () => {
    mockResolvedPresets = [wirePreset(), wirePreset({ id: "rx_2", name: "Mood" })];
    const { container } = await mountTopBar();
    const indicator = container.querySelector("[data-testid='topbar-regex-indicator']");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("2");
  });

  test("hidden when no presets resolve", async () => {
    mockResolvedPresets = [];
    const { container } = await mountTopBar();
    const indicator = container.querySelector("[data-testid='topbar-regex-indicator']");
    expect(indicator).toBeNull();
  });

  test("hidden when all resolved presets are disabled", async () => {
    mockResolvedPresets = [wirePreset({ disabled: true })];
    const { container } = await mountTopBar();
    const indicator = container.querySelector("[data-testid='topbar-regex-indicator']");
    expect(indicator).toBeNull();
  });

  test("resolve failure degrades silently — no indicator, no crash", async () => {
    mockResolveFails = true;
    const { container } = await mountTopBar();
    expect(container.querySelector("[data-testid='topbar-regex-indicator']")).toBeNull();
    mockResolveFails = false;
  });
});
