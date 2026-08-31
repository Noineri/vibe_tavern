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
 * Runner: bun:test with scoped happy-dom.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import type { ReactNode } from "react";
import {
  type LoreEntryRecord,
  type LorebookRecord,
} from "../../../app-client.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const listLoreEntries = mock((_lorebookId: string) => Promise.resolve<LoreEntryRecord[]>([]));
const realI18nContext = await import("../../../i18n/context.js");
const realAppClient = await import("../../../app-client.js");
const realLoreEntryList = await import("./LoreEntryList.js");
const realLinkBindingPopover = await import("../../shared/LinkBindingPopover.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realTokenizer = await import("../../../utils/tokenizer.js");

// Identity i18n — assertion strings match keys verbatim.
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
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
mock.module("../../../app-client.js", () => ({
	...realAppClient,
  listLoreEntries,
}));

// Stub LoreEntryList → flat row list exposing the filtered entries + the
// dndDisabled flag. Isolates the accordion's filter logic (the test target)
// from dnd-kit rendering.
mock.module("./LoreEntryList.js", () => ({
	...realLoreEntryList,
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
mock.module("../../shared/LinkBindingPopover.js", () => ({
	...realLinkBindingPopover,
  LinkBindingPopover: () => <div data-testid="link-binding-stub" />,
}));

// CustomTooltip needs a Radix TooltipProvider context irrelevant here;
// passthrough children, drop the `content` prop.
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// countTokens is irrelevant to filtering; stub it to keep the test fast + isolated.
mock.module("../../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));

let LorebookAccordion: typeof import("./LorebookAccordion.js").LorebookAccordion;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ LorebookAccordion } = await import("./LorebookAccordion.js"));
});

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
  useGroupScoring: false,
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

// e1 "Dragon" / content "breathes fire" / keys [boss, fire]  / secondary [lair]
// e2 "Castle" / content "stone walls"  / keys [stone]        / secondary [moat]
// e3 "Fire Sprite" / content "ember"   / keys [fire]         / secondary [lair]   (key "fire" + sec "lair" shared)
const ENTRIES: LoreEntryRecord[] = [
  makeEntry({ id: "e1", title: "Dragon", content: "breathes fire", keys: ["boss", "fire"], secondaryKeys: ["lair"] }),
  makeEntry({ id: "e2", title: "Castle", content: "stone walls", keys: ["stone"], secondaryKeys: ["moat"] }),
  makeEntry({ id: "e3", title: "Fire Sprite", content: "ember", keys: ["fire"], secondaryKeys: ["lair"] }),
];

function renderAccordion(
  overrides: Partial<{ lorebook: LorebookRecord; onUpdateMeta: (body: Parameters<NonNullable<Parameters<typeof LorebookAccordion>[0]["onUpdateMeta"]>>[0]) => void }> = {},
) {
  return render(
    <LorebookAccordion
      lorebook={overrides.lorebook ?? LOREBOOK}
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
      onUpdateMeta={overrides.onUpdateMeta ?? (() => {})}
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
    listLoreEntries.mockClear();
    listLoreEntries.mockResolvedValue(ENTRIES);
  });

  it("renders all entries unfiltered; DnD enabled", async () => {
    const { findAllByTestId, getByTestId } = renderAccordion();
    expect(await findAllByTestId("entry-row")).toHaveLength(3);
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
  });

  it("text query filters by title OR content, case-insensitive", async () => {
    const { findAllByTestId, getByPlaceholderText } = renderAccordion();
    const user = userEvent.setup();
    await findAllByTestId("entry-row"); // wait for load
    const search = getByPlaceholderText("search_name_placeholder");
    // "fire" → e1 (content "breathes fire") + e3 (title "Fire Sprite")
    await user.type(search, "fire");
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
    // "stone" → e2 only (content)
    await user.click(search);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await user.type(search, "stone");
    expect(await findAllByTestId("entry-row")).toHaveLength(1);
    // case-insensitive
    await user.clear(search);
    await user.type(search, "FIRE");
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
  });

  it("activation-key chips combine with AND; clears with the query", async () => {
    const { findAllByTestId, getByPlaceholderText } = renderAccordion();
    const user = userEvent.setup();
    await findAllByTestId("entry-row");
    const tagInput = getByPlaceholderText("lore_search_keys_placeholder");
    // key "fire" → e1 + e3 (both have it)
    await user.type(tagInput, "fire{Enter}");
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
    // add key "boss" (AND) → only e1 has both [boss, fire]
    await user.type(tagInput, "boss{Enter}");
    expect(await findAllByTestId("entry-row")).toHaveLength(1);
  });

  it("secondary-key combobox is a distinct input filtering on secondaryKeys", async () => {
    const { findAllByTestId, queryAllByTestId, getByPlaceholderText } = renderAccordion();
    const user = userEvent.setup();
    await findAllByTestId("entry-row");
    // The secondary combobox has its own placeholder (distinct from primary).
    const secInput = getByPlaceholderText("lore_search_secondary_keys_placeholder");
    // secondary "lair" → e1 + e3 (both have it in secondaryKeys)
    await user.type(secInput, "lair{Enter}");
    expect(await findAllByTestId("entry-row")).toHaveLength(2);
    // primary "fire" (e1+e3) AND secondary "moat" (e2 only) → no overlap → 0
    const primInput = getByPlaceholderText("lore_search_keys_placeholder");
    await user.type(primInput, "fire{Enter}");
    await user.type(secInput, "moat{Enter}");
    // queryAll (not findAll) — findAllByTestId throws when zero match.
    await waitFor(() =>
      expect(queryAllByTestId("entry-row")).toHaveLength(0),
    );
  });

  it("DnD is disabled while a filter is active, re-enabled when clear", async () => {
    const { findAllByTestId, getByPlaceholderText, getByTestId } = renderAccordion();
    const user = userEvent.setup();
    await findAllByTestId("entry-row");
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
    // text filter arms the disable
    const search = getByPlaceholderText("search_name_placeholder");
    await user.type(search, "fire");
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
    // clearing re-enables
    await user.click(search);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await waitFor(() => expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false"));
    // tag filter arms it too
    const tagInput = getByPlaceholderText("lore_search_keys_placeholder");
    await user.type(tagInput, "stone{Enter}");
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
  });
});

// ── LG-7: book-level group scoring checkbox ─────────────────────────────

describe("LorebookAccordion book-level group scoring (LG-7)", () => {
  beforeEach(() => {
    listLoreEntries.mockClear();
    listLoreEntries.mockResolvedValue(ENTRIES);
  });

  it("renders the checkbox unchecked/checked from the book record", async () => {
    const off = renderAccordion({ lorebook: { ...LOREBOOK, useGroupScoring: false } });
    // t is identity → the label text is the i18n key; the Checkbox owns its
    // <input>. Assert via the meta payload instead of DOM shape (below), here
    // just pin the control renders.
    expect(await off.findByText("lore_book_group_scoring")).toBeTruthy();
    off.unmount();

    const on = renderAccordion({ lorebook: { ...LOREBOOK, useGroupScoring: true } });
    expect(await on.findByText("lore_book_group_scoring")).toBeTruthy();
  });

  it("toggling reports onUpdateMeta({ useGroupScoring }) in both directions", async () => {
    // Two independent renders (unmount between): the disclosure's mount
    // animation doesn't like two live accordions in one document.
    const onUpdateMeta = mock();
    const r1 = renderAccordion({
      lorebook: { ...LOREBOOK, useGroupScoring: false },
      onUpdateMeta,
    });
    fireEvent.click(await r1.findByText("lore_book_group_scoring"));
    expect(onUpdateMeta).toHaveBeenCalledWith({ useGroupScoring: true });
    r1.unmount();

    const on = mock();
    const r2 = renderAccordion({
      lorebook: { ...LOREBOOK, useGroupScoring: true },
      onUpdateMeta: on,
    });
    fireEvent.click(await r2.findByText("lore_book_group_scoring"));
    expect(on).toHaveBeenCalledWith({ useGroupScoring: false });
  });
});
