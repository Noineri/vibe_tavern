import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { brandId } from "@vibe-tavern/domain";
import type { CharacterId, ChatId, RegexPresetId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { installRadixPopoverSeam } from "../../../test/radix-popover-seam.js";
import { installSnapshotStoreSeam } from "../../../test/snapshot-store-seam.js";
import { wireCharacter, wireChat, wireRegexPreset } from "../../../test/wire-fixtures.js";
import type { ReactNode } from "react";
import type { RegexPresetRecord } from "../../api/types.js";

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

const realRegexApi = await import("../../api/regex-api.js");
const realUsePresetController = await import("../../hooks/use-preset-controller.js");
const realUseProviderProfiles = await import("../../hooks/use-provider-profiles.js");
const realTooltip = await import("../shared/Tooltip.js");

installI18nContextSeam({ interpolateKeys: ["topbar_regex_active_one", "topbar_regex_active_many"] });

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
// below in TopBar — the shared radix-popover seam keeps the real export
// surface alive for every co-loaded file and stubs only the (single,
// uncontrolled) Root arm deterministically (CO-LOAD CONTRACT: the former
// inline passthrough stayed live process-globally and rendered closed
// controlled popovers' content at rest — e.g. AgentContextRing's meter —
// breaking real-arm riders in a hand-bundled run).
installRadixPopoverSeam();

// CO-LOAD CONTRACT (snapshot-store seam): the harness seeds the REAL store
// (`useSnapshotStore.getState().ingestSnapshot(...)` in mountTopBar) — register
// the real arm so a co-loaded narrow-store mock cannot leave a plain function
// live for it in a hand-bundled run.
installSnapshotStoreSeam();

// RX-14 seam under test — what the indicator counts. Overridden per test.
// Typed as the real resolution row so the override needs no cast: the mock's
// return IS `Awaited<ReturnType<typeof realRegexApi.resolveActiveRegexPresets>>`.
let mockResolvedPresets: RegexPresetRecord[] = [];
let mockResolveFails = false;
mock.module("../../api/regex-api.js", () => ({
  ...realRegexApi,
  resolveActiveRegexPresets: async () => {
    if (mockResolveFails) throw new Error("network down");
    return mockResolvedPresets;
  },
}));

beforeAll(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    // The 7a annotation shape: the shim literal is checked against the real
    // MediaQueryList type instead of casting the finished object to it.
    window.matchMedia = (q: string): MediaQueryList => ({
      matches: false, media: q, onchange: null,
      addEventListener: NOOP, removeEventListener: NOOP,
      addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
    });
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

/** Complete preset rows come from the wire factory (the ONE derivation of the
 *  RegexPreset wire row); the file only pins the display names. */
function wirePreset(overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
  return wireRegexPreset({ name: "Strip tags", ...overrides });
}

/** Desktop TopBar (isMobile false via matchMedia shim) with the indicator slot. */
async function mountTopBar() {
  const { TopBar } = await loadModules();
  // Seed the snapshot store so useChatMeta resolves a characterId — without
  // it the indicator hook has no key and never fetches.
  const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
  const { useChatStore } = await import("../../stores/chat-store.js");
  // Snapshot rows ride the wire factories — the ONE derivation of the
  // active-chat/character rows (the erased literal carried partial rows whose
  // missing fields the compiler never saw; the factories carry production's
  // persisted defaults instead).
  useSnapshotStore.getState().ingestSnapshot({
    chats: [],
    allCharacters: [],
    messages: [],
    summaries: [],
    activeChat: wireChat({
      id: brandId<ChatId>("chat-1"),
      title: "Chat 1",
      characterId: brandId<CharacterId>("c1"),
    }),
    character: wireCharacter({
      id: brandId<CharacterId>("c1"),
      name: "Test Char",
    }),
    persona: null,
  });
  useChatStore.getState().setActiveChatId("chat-1" as import("@vibe-tavern/domain").ChatId);
  const utils = render(<TopBar />);
  // Flush the async preset fetch so the indicator settles.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return utils;
}

describe("TopBar — RX-14 global-regex indicator", () => {
  test("renders the enabled count when regex presets are active", async () => {
    mockResolvedPresets = [wirePreset(), wirePreset({ id: brandId<RegexPresetId>("rx_2"), name: "Mood" })];
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
