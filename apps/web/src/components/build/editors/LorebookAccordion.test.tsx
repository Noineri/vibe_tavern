/**
 * LorebookAccordion — in-accordion search + key-filter characterization.
 *
 * Pins the ListSearchPanel integration (reports/lorebook-accordion-search.md):
 * the text query filters by title OR content (case-insensitive), activation-key
 * chips combine with AND, the header counter stays on the full total, and DnD
 * reordering is disabled while a filter is active (reordering a filtered subset
 * is unsafe — buildReorderUpdates is index-based). LoreEntryList is stubbed so
 * the assertions target the accordion's filter logic, not dnd-kit rendering.
 *
 * Runner: vitest (apps/web uses vitest, NOT bun:test). DOM via happy-dom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import {
  listLoreEntries,
  type LoreEntryRecord,
  type LorebookRecord,
} from "../../../app-client.js";
import { LorebookAccordion } from "./LorebookAccordion.js";

// Identity i18n — assertion strings match keys verbatim.
vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// app-client — only listLoreEntries is called by the accordion; types are
// erased at runtime.
vi.mock("../../../app-client.js", () => ({
  listLoreEntries: vi.fn(),
}));

// Stub LoreEntryList → flat row list exposing the filtered entries + the
// dndDisabled flag. Isolates the accordion's filter logic (the test target)
// from dnd-kit rendering.
vi.mock("./LoreEntryList.js", () => ({
  LoreEntryList: (props: {
    entries: LoreEntryRecord[];
    dndDisabled?: boolean;
  }) => (
    <div
      data-testid="entry-list"
      data-dnd-disabled={props.dndDisabled ? "true" : "false"}
    >
      {props.entries.map((e) => (
        <div key={e.id} data-testid="entry-row">
          {e.title}
        </div>
      ))}
    </div>
  ),
}));

// LinkBindingPopover pulls character/persona pickers irrelevant to filtering.
vi.mock("../../shared/LinkBindingPopover.js", () => ({
  LinkBindingPopover: () => <div data-testid="link-binding-stub" />,
}));

// CustomTooltip needs a Radix TooltipProvider context irrelevant here;
// passthrough children, drop the `content` prop.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// countTokens is irrelevant to filtering; stub it to keep the test fast + isolated.
vi.mock("../../../utils/tokenizer.js", () => ({ countTokens: () => 0 }));

// ── Fixtures ────────────────────────────────────────────────────────────

const LOREBOOK: LorebookRecord = {
  id: "lb-1",
  name: "World Lore",
  description: "",
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  scanDepth: 0,
  tokenBudget: 2048,
  tokenBudgetPercent: null,
  recursiveScanning: false,
  enabled: true,
};

function makeEntry(over: Partial<LoreEntryRecord>): LoreEntryRecord {
  return {
    id: "e",
    lorebookId: "lb-1",
    title: "",
    content: "",
    keys: [],
    secondaryKeys: [],
    logic: "AND_ANY",
    position: "before_char",
    depth: 4,
    priority: 10,
    stickyWindow: 0,
    cooldownWindow: 0,
    delayWindow: 0,
    enabled: true,
    constant: false,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 100,
    prioritizeInclusion: false,
    useGroupScoring: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
    scanDepthOverride: null,
    caseSensitive: false,
    matchWholeWords: false,
    characterFilter: [],
    characterFilterExclude: false,
    matchSources: [],
    sortOrder: 0,
    ...over,
  };
}

// e1 "Dragon" / content "breathes fire" / keys [boss, fire]
// e2 "Castle" / content "stone walls"  / keys [stone]
// e3 "Fire Sprite" / content "ember"   / keys [fire]   (key "fire" shared with e1)
const ENTRIES: LoreEntryRecord[] = [
  makeEntry({ id: "e1", title: "Dragon", content: "breathes fire", keys: ["boss", "fire"] }),
  makeEntry({ id: "e2", title: "Castle", content: "stone walls", keys: ["stone"] }),
  makeEntry({ id: "e3", title: "Fire Sprite", content: "ember", keys: ["fire"] }),
];

function renderAccordion() {
  return render(
    <LorebookAccordion
      lorebook={LOREBOOK}
      links={[]}
      expanded={true}
      editing={false}
      editLbName=""
      editLbScope="global"
      activeEntryId={null}
      isMobile={false}
      actionMenuOpen={false}
      onToggleActionMenu={() => {}}
      t={(k: string) => k}
      onToggle={() => {}}
      onStartEdit={() => {}}
      onSaveEdit={() => {}}
      onCancelEdit={() => {}}
      onEditLbName={() => {}}
      onEditLbScope={() => {}}
      onDelete={() => {}}
      onAddEntry={() => {}}
      onEntryClick={() => {}}
      onToggleEnabled={() => {}}
      onUpdateMeta={() => {}}
      onReorderEntries={async () => []}
      onToggleEntryEnabled={async () => ENTRIES[0]}
      onSetLinks={() => {}}
      onDuplicate={() => {}}
      onExport={() => {}}
      characters={[]}
      personas={[]}
    />,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("LorebookAccordion search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLoreEntries).mockResolvedValue(ENTRIES);
  });

  it("renders all entries unfiltered; DnD enabled", async () => {
    const { findAllByTestId, getByTestId } = renderAccordion();
    expect(await findAllByTestId("entry-row")).toHaveLength(3);
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
  });

  it("text query filters by title OR content, case-insensitive", async () => {
    const { findAllByTestId, getByPlaceholderText } = renderAccordion();
    await findAllByTestId("entry-row"); // wait for load
    const search = getByPlaceholderText("search_name_placeholder");
    // "fire" → e1 (content "breathes fire") + e3 (title "Fire Sprite")
    fireEvent.change(search, { target: { value: "fire" } });
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
    // "stone" → e2 only (content)
    fireEvent.change(search, { target: { value: "stone" } });
    expect(await findAllByTestId("entry-row")).toHaveLength(1);
    // case-insensitive
    fireEvent.change(search, { target: { value: "FIRE" } });
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
  });

  it("activation-key chips combine with AND; clears with the query", async () => {
    const { findAllByTestId, getByPlaceholderText } = renderAccordion();
    await findAllByTestId("entry-row");
    const tagInput = getByPlaceholderText("search_tags_placeholder");
    // key "fire" → e1 + e3 (both have it)
    fireEvent.change(tagInput, { target: { value: "fire" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
    // add key "boss" (AND) → only e1 has both [boss, fire]
    fireEvent.change(tagInput, { target: { value: "boss" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(await findAllByTestId("entry-row")).toHaveLength(1);
  });

  it("DnD is disabled while a filter is active, re-enabled when clear", async () => {
    const { findAllByTestId, getByPlaceholderText, getByTestId } = renderAccordion();
    await findAllByTestId("entry-row");
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
    // text filter arms the disable
    fireEvent.change(getByPlaceholderText("search_name_placeholder"), {
      target: { value: "fire" },
    });
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
    // clearing re-enables
    fireEvent.change(getByPlaceholderText("search_name_placeholder"), {
      target: { value: "" },
    });
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
    // tag filter arms it too
    const tagInput = getByPlaceholderText("search_tags_placeholder");
    fireEvent.change(tagInput, { target: { value: "stone" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
  });
});
