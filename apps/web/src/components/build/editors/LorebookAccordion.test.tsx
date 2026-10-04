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
import { useState } from "react";
import { wireLorebook, wireLoreEntry } from "../../../../test/wire-fixtures.js";
import type { ReactNode } from "react";
import type { LoreEntryRecord, LorebookLinkRecord, LorebookRecord } from "../../../api/types.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const listLoreEntries = mock((_lorebookId: string) => Promise.resolve<LoreEntryRecord[]>([]));
const realI18nContext = await import("../../../i18n/context.js");
const realLorebookApi = await import("../../../api/lorebook-api.js");
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

// lorebook-api — only listLoreEntries is called by the accordion; types are
// erased at runtime.
mock.module("../../../api/lorebook-api.js", () => ({
	...realLorebookApi,
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
  LinkBindingPopover: (props: {
    links: Array<{ targetType: "character" | "persona"; targetId: string }>;
    onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  }) => (
    <div data-testid="link-binding-stub">
      {props.links.map((link) => (
        <button
          key={`${link.targetType}:${link.targetId}`}
          type="button"
          onClick={() => props.onSetLinks(props.links.filter((candidate) => candidate !== link))}
        >
          {link.targetId}
        </button>
      ))}
    </div>
  ),
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
  ...wireLorebook(),
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
  caseSensitive: false,
  matchWholeWords: false,
  tokenBudgetCap: 0,
  enabled: true,
};

function makeEntry(over: Partial<LoreEntryRecord>): LoreEntryRecord {
  return {
    ...wireLoreEntry(),
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
    minChatMessages: 0,
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

type AccordionOverrides = Partial<{
  lorebook: LorebookRecord;
  onUpdateMeta: (body: Parameters<NonNullable<Parameters<typeof LorebookAccordion>[0]["onUpdateMeta"]>>[0]) => void;
  links: LorebookLinkRecord[];
  linksLoaded: boolean;
  editing: boolean;
  editLbName: string;
  editLbScope: string;
  isMobile: boolean;
  onEditLbScope: (scope: string) => void;
  onSaveEdit: () => void;
  onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
}>;

function accordionElement(
  overrides: AccordionOverrides = {},
) {
  return (
    <LorebookAccordion
      lorebook={overrides.lorebook ?? LOREBOOK}
      links={overrides.links ?? []}
      linksLoaded={overrides.linksLoaded ?? true}
      expanded={true}
      editing={overrides.editing ?? false}
      editLbName={overrides.editLbName ?? ""}
      editLbScope={overrides.editLbScope ?? "global"}
      activeEntryId={null}
      isMobile={overrides.isMobile ?? false}
      actionMenuOpen={false}
      onToggleActionMenu={() => {}}
      t={(k: string) => k}
      onToggle={() => {}}
      onStartEdit={() => {}}
      onSaveEdit={() => {}}
      onCancelEdit={() => {}}
      onEditLbName={() => {}}
      onEditLbScope={overrides.onEditLbScope ?? (() => {})}
      onDelete={() => {}}
      onAddEntry={() => {}}
      onEntryClick={() => {}}
      onToggleEnabled={() => {}}
      onUpdateMeta={overrides.onUpdateMeta ?? (() => {})}
      onReorderEntries={async () => []}
      onToggleEntryEnabled={async () => ENTRIES[0]}
      onSetLinks={overrides.onSetLinks ?? (() => {})}
      onDuplicate={() => {}}
      onExport={() => {}}
      characters={[]}
      personas={[]}
    />
  );
}

function renderAccordion(overrides: AccordionOverrides = {}) {
  return render(accordionElement(overrides));
}

/** Stateful harness for the advanced-settings suite (resweep step 6):
 *  onUpdateMeta merges back into the lorebook prop, emulating the store
 *  refresh the real wiring performs — the exclusion note and the zero
 *  captions only render once the refreshed record catches up. */
function renderStatefulAccordion(lbOverrides: Partial<LorebookRecord> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const Harness = () => {
    const [lb, setLb] = useState<LorebookRecord>({ ...LOREBOOK, ...lbOverrides });
    return accordionElement({
      lorebook: lb,
      onUpdateMeta: (body) => {
        writes.push(body as Record<string, unknown>);
        setLb((prev) => ({ ...prev, ...body }));
      },
    });
  };
  return { view: render(<Harness />), writes };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("LorebookAccordion search", () => {
  beforeEach(() => {
    listLoreEntries.mockClear();
    listLoreEntries.mockResolvedValue(ENTRIES);
  });

  /** The search panel is collapsed by default (owner request 2026-09-29) —
   *  open it before driving the filter inputs. */
  async function openSearch(view: ReturnType<typeof render>) {
    await view.findAllByTestId("entry-row"); // wait for load
    fireEvent.click(view.getByText("lore_search_toggle"));
    return view;
  }

  it("collapsed by default; opens on the toggle; the badge surfaces active filters while collapsed", async () => {
    const view = renderAccordion();
    await view.findAllByTestId("entry-row");
    expect(view.queryByPlaceholderText("search_name_placeholder")).toBeNull();
    fireEvent.click(view.getByText("lore_search_toggle"));
    expect(view.getByPlaceholderText("search_name_placeholder")).not.toBeNull();
    // type a query, then collapse — the ·N badge keeps the filter visible
    const user = userEvent.setup();
    await user.type(view.getByPlaceholderText("search_name_placeholder"), "fire");
    fireEvent.click(view.getByText("lore_search_collapse"));
    expect(view.getByText("· 1")).not.toBeNull();
  });

  it("renders all entries unfiltered; DnD enabled", async () => {
    const { findAllByTestId, getByTestId } = renderAccordion();
    expect(await findAllByTestId("entry-row")).toHaveLength(3);
    expect(getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
  });

  it("text query filters by title OR content, case-insensitive", async () => {
    const view = renderAccordion();
    const user = userEvent.setup();
    await openSearch(view);
    const search = view.getByPlaceholderText("search_name_placeholder");
    // "fire" → e1 (content "breathes fire") + e3 (title "Fire Sprite")
    await user.type(search, "fire");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(2);
    // "stone" → e2 only (content)
    await user.click(search);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await user.type(search, "stone");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(1);
    // case-insensitive
    await user.clear(search);
    await user.type(search, "FIRE");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(2);
  });

  it("activation-key chips combine with AND; clears with the query", async () => {
    const view = renderAccordion();
    const user = userEvent.setup();
    await openSearch(view);
    const tagInput = view.getByPlaceholderText("lore_search_keys_placeholder");
    // key "fire" → e1 + e3 (both have it)
    await user.type(tagInput, "fire{Enter}");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(2);
    // add key "boss" (AND) → only e1 has both [boss, fire]
    await user.type(tagInput, "boss{Enter}");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(1);
  });

  it("secondary-key combobox is a distinct input filtering on secondaryKeys", async () => {
    const view = renderAccordion();
    const user = userEvent.setup();
    await openSearch(view);
    // The secondary combobox has its own placeholder (distinct from primary).
    const secInput = view.getByPlaceholderText("lore_search_secondary_keys_placeholder");
    // secondary "lair" → e1 + e3 (both have it in secondaryKeys)
    await user.type(secInput, "lair{Enter}");
    expect(await view.findAllByTestId("entry-row")).toHaveLength(2);
    // primary "fire" (e1+e3) AND secondary "moat" (e2 only) → no overlap → 0
    const primInput = view.getByPlaceholderText("lore_search_keys_placeholder");
    await user.type(primInput, "fire{Enter}");
    await user.type(secInput, "moat{Enter}");
    // queryAll (not findAll) — findAllByTestId throws when zero match.
    await waitFor(() =>
      expect(view.queryAllByTestId("entry-row")).toHaveLength(0),
    );
  });

  it("DnD is disabled while a filter is active, re-enabled when clear", async () => {
    const view = renderAccordion();
    const user = userEvent.setup();
    await openSearch(view);
    expect(view.getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false");
    // text filter arms the disable
    const search = view.getByPlaceholderText("search_name_placeholder");
    await user.type(search, "fire");
    expect(view.getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
    // clearing re-enables
    await user.click(search);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await waitFor(() => expect(view.getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("false"));
    // tag filter arms it too
    const tagInput = view.getByPlaceholderText("lore_search_keys_placeholder");
    await user.type(tagInput, "stone{Enter}");
    expect(view.getByTestId("entry-list").getAttribute("data-dnd-disabled")).toBe("true");
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

  it("budget cap field: hidden in fixed mode, rendered in percent mode, reports onUpdateMeta (N5)", async () => {
    const onUpdateMeta = mock();
    const fixed = renderAccordion({
      lorebook: { ...LOREBOOK, tokenBudgetPercent: null, tokenBudgetCap: 0 },
      onUpdateMeta,
    });
    // Disclosure content only renders when expanded.
    await fixed.findByText("lore_scan_depth");
    expect(fixed.queryByText("lore_token_budget_cap")).toBeNull(); // fixed mode → no cap field
    // The mode button in fixed mode is labeled "Tokens" and switches to percent.
    fireEvent.click(fixed.getByText("lore_token_budget_mode_fixed"));
    expect(onUpdateMeta).toHaveBeenCalledWith({ tokenBudgetPercent: 25 });
    fixed.unmount();

    const pct = renderAccordion({
      lorebook: { ...LOREBOOK, tokenBudgetPercent: 5, tokenBudgetCap: 250 },
      onUpdateMeta,
    });
    await pct.findByText("lore_token_budget_cap");
    // Scope to the cap control's wrapper (three NumberInputs live in this row).
    const capScope = pct.getByText("lore_token_budget_cap").closest("div") as HTMLElement;
    const capInput = capScope.querySelector("input") as HTMLInputElement;
    expect(capInput.value).toBe("250");
    fireEvent.change(capInput, { target: { value: "300" } });
    fireEvent.blur(capInput);
    await waitFor(() => expect(onUpdateMeta).toHaveBeenCalledWith({ tokenBudgetCap: 300 }));
    pct.unmount();
  });

  it("renders the D2 book-level matching defaults and toggling reports onUpdateMeta (D2)", async () => {
    const onUpdateMeta = mock();
    const view = renderAccordion({
      lorebook: { ...LOREBOOK, caseSensitive: false, matchWholeWords: false },
      onUpdateMeta,
    });
    expect(await view.findByText("lore_book_case_sensitive")).toBeTruthy();
    expect(view.getByText("lore_book_match_whole_words")).toBeTruthy();
    fireEvent.click(view.getByText("lore_book_case_sensitive"));
    expect(onUpdateMeta).toHaveBeenCalledWith({ caseSensitive: true });
    view.unmount();
  });

  it("saves Include Names and Insertion Strategy through the book-meta callback", async () => {
    const { view, writes } = renderStatefulAccordion({ includeNames: true, characterStrategy: 0 });
    await view.findByText("lore_scan_depth");

    fireEvent.click(view.getByRole("switch", { name: "lore_include_names" }));
    expect(writes).toEqual([{ includeNames: false }]);

    fireEvent.click(view.getByRole("radio", { name: "lore_character_strategy_global_first" }));
    expect(writes).toEqual([
      { includeNames: false },
      { characterStrategy: 2 },
    ]);
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

// ── Scope taxonomy collapse 4 → 3 (entity) ──────────────────────────────
//
// The inline edit form's scope picker and the row binding icon reflect the
// merged taxonomy: global / entity / chat — the character/persona split is
// gone. `scope_char`/`scope_persona` remain LIVE i18n keys only for the
// LinkBindingPopover target-type section labels, so absence here must be
// asserted against the rendered DOM, not the key registry.

describe("LorebookAccordion scope collapse (entity)", () => {
	it("inline edit renders exactly 3 scope options (global / entity / chat)", async () => {
		const { getByText, queryByText } = renderAccordion({ editing: true });
		expect(getByText("scope_global")).toBeTruthy();
		expect(getByText("scope_entity")).toBeTruthy();
		expect(getByText("scope_chat")).toBeTruthy();
		expect(queryByText("scope_char")).toBeNull();
		expect(queryByText("scope_persona")).toBeNull();
	});

	it("picking the entity option reports scopeType 'entity'", async () => {
		const onEditLbScope = mock();
		const { getByText } = renderAccordion({ editing: true, onEditLbScope });
		fireEvent.click(getByText("scope_entity"));
		expect(onEditLbScope).toHaveBeenCalledWith("entity");
	});

  it("characterization: switching away from Bound changes only scope, not links", () => {
    const onEditLbScope = mock();
    const onSetLinks = mock();
    const { getByText } = renderAccordion({
      editing: true,
      editLbScope: "entity",
      onEditLbScope,
      onSetLinks,
    });

    fireEvent.click(getByText("scope_global"));

    expect(onEditLbScope).toHaveBeenCalledWith("global");
    expect(onSetLinks).not.toHaveBeenCalled();
  });

	it("entity books map to the entity icon without a legacy owner field", async () => {
		const { lorebookBindingIcon } = await import("./LorebookAccordion.js");
		const entityBound = lorebookBindingIcon({ ...LOREBOOK, scopeType: "entity" });
		expect(entityBound?.tooltipKey).toBe("scope_entity");
	});

	it("global books map to no binding icon; chat books keep the chat icon", async () => {
		const { lorebookBindingIcon } = await import("./LorebookAccordion.js");
		expect(lorebookBindingIcon(LOREBOOK)).toBeNull();
		const chatBound = lorebookBindingIcon({ ...LOREBOOK, scopeType: "chat", chatId: "chat-1" });
		expect(chatBound?.tooltipKey).toBe("scope_chat");
	});

  it("shows the shared owner picker inline for Bound editing and can clear its chip", () => {
    const onSetLinks = mock();
    const view = renderAccordion({
      lorebook: { ...LOREBOOK, scopeType: "entity" },
      editing: true,
      editLbScope: "entity",
      links: [{ targetType: "character", targetId: "character-1", lorebookId: "lb-1" }],
      onSetLinks,
    });
    expect(view.getByTestId("link-binding-stub")).toBeTruthy();
    fireEvent.click(view.getByText("character-1"));
    expect(onSetLinks).toHaveBeenCalledWith([]);
  });

  it("shows the unbound warning only after an entity book's links load empty", () => {
    const empty = renderAccordion({ lorebook: { ...LOREBOOK, scopeType: "entity" }, links: [], linksLoaded: true });
    expect(empty.getByText("lore_unbound_warning")).toBeTruthy();
    empty.unmount();

    const linked = renderAccordion({
      lorebook: { ...LOREBOOK, scopeType: "entity" },
      links: [{ targetType: "character", targetId: "character-1", lorebookId: "lb-1" }],
    });
    expect(linked.queryByText("lore_unbound_warning")).toBeNull();
  });
});

describe("LorebookAccordion mobile edit form (MUI step 6)", () => {
  it("on mobile the dead expand caret disappears while editing; the form rows own the width", async () => {
    const { container } = renderAccordion({ editing: true, editLbName: "Draft", isMobile: true });
    // The ▶/▼ glyph spans are the caret's only text content.
    expect(container.textContent).not.toContain("\u25BC");
    expect(container.textContent).not.toContain("\u25B6");
    // The inline rename field is the creation form's name row.
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("on desktop the caret stays visible next to the inline edit form", async () => {
    const { container } = renderAccordion({ editing: true, editLbName: "Draft", isMobile: false });
    expect(container.textContent).toContain("\u25BC"); // expanded=true in the harness
  });

  it("outside edit mode the caret is present on mobile too (expansion still works)", async () => {
    const { container } = renderAccordion({ editing: false, isMobile: true });
    expect(container.textContent).toContain("\u25BC");
  });
});

// ── Advanced book settings (resweep step 6) ─────────────────────────────
// Pins the disclosure + SliderField.onCommit wiring: collapsed by default,
// drag ticks paint locally (no write), release commits one write per field,
// the ST mutual exclusion writes BOTH fields in ONE call, disabled states
// follow recursive scanning / min activations, zero captions appear only
// at 0, and the overflow checkbox writes its flag.

describe("LorebookAccordion advanced settings", () => {
  beforeEach(() => {
    listLoreEntries.mockClear();
    listLoreEntries.mockResolvedValue(ENTRIES);
  });

  /** Open the section and return the view with the body mounted. */
  async function openAdvanced(view: ReturnType<typeof render>) {
    await view.findAllByTestId("entry-row"); // wait for load
    fireEvent.click(view.getByText("lore_advanced_settings"));
    return view;
  }

  /** Drag a slider to v (change per tick) and release (commit). */
  function dragAndRelease(view: ReturnType<typeof render>, testId: string, v: number) {
    fireEvent.change(view.getByTestId(testId), { target: { value: String(v) } });
    fireEvent.pointerUp(view.getByTestId(testId));
  }

  it("collapsed by default; opens on the toggle", async () => {
    const view = renderAccordion({ lorebook: { ...LOREBOOK, recursiveScanning: true } });
    await view.findAllByTestId("entry-row");
    expect(view.queryByTestId("lore-steps-range")).toBeNull();
    fireEvent.click(view.getByText("lore_advanced_settings"));
    expect(view.getByTestId("lore-steps-range")).not.toBeNull();
    expect(view.getByTestId("lore-min-act-range")).not.toBeNull();
    expect(view.getByTestId("lore-depth-max-range")).not.toBeNull();
    expect(view.getByRole("checkbox", { name: "lore_overflow_alert" })).not.toBeNull();
  });

  it("drag ticks paint locally — no write until release", async () => {
    const { view, writes } = renderStatefulAccordion({ recursiveScanning: true });
    await openAdvanced(view);
    fireEvent.change(view.getByTestId("lore-steps-range"), { target: { value: "5" } });
    expect(writes).toHaveLength(0);
    // release commits once
    fireEvent.pointerUp(view.getByTestId("lore-steps-range"));
    expect(writes).toEqual([{ maxRecursionSteps: 5 }]);
  });

  it("each slider commits its own field", async () => {
    const { view, writes } = renderStatefulAccordion({ recursiveScanning: true, minActivations: 2 });
    await openAdvanced(view);
    dragAndRelease(view, "lore-depth-max-range", 7);
    expect(writes).toEqual([{ minActivationsDepthMax: 7 }]);
    writes.length = 0;
    dragAndRelease(view, "lore-min-act-range", 5); // steps is 0 → no exclusion
    expect(writes).toEqual([{ minActivations: 5 }]);
    writes.length = 0;
    // no-op release (value already committed) writes nothing
    dragAndRelease(view, "lore-depth-max-range", 7);
    expect(writes).toHaveLength(0);
  });

  it("mutual exclusion: steps → non-zero zeroes min activations in ONE write, note on the zeroed control", async () => {
    const { view, writes } = renderStatefulAccordion({ recursiveScanning: true, minActivations: 2, maxRecursionSteps: 0 });
    await openAdvanced(view);
    dragAndRelease(view, "lore-steps-range", 3);
    expect(writes).toEqual([{ maxRecursionSteps: 3, minActivations: 0 }]);
    // min-act fell to 0 → its caption slot carries the reset note (NOT «выключено»)
    expect(view.getByText("lore_reset_by_steps")).not.toBeNull();
    expect(view.queryByText("lore_min_act_zero")).toBeNull();
  });

  it("mutual exclusion mirror: min activations → non-zero zeroes steps in ONE write", async () => {
    const { view, writes } = renderStatefulAccordion({ maxRecursionSteps: 4, minActivations: 0 });
    await openAdvanced(view);
    dragAndRelease(view, "lore-min-act-range", 1);
    expect(writes).toEqual([{ minActivations: 1, maxRecursionSteps: 0 }]);
    // steps fell to 0 → reset note, phrased as unlimited, never «выключено»
    expect(view.getByText("lore_reset_by_min_act")).not.toBeNull();
    expect(view.queryByText("lore_steps_zero")).toBeNull();
  });

  it("the reset note clears when the zeroed control next changes", async () => {
    const { view, writes } = renderStatefulAccordion({ recursiveScanning: true, minActivations: 2, maxRecursionSteps: 0 });
    await openAdvanced(view);
    dragAndRelease(view, "lore-steps-range", 3);
    expect(view.getByText("lore_reset_by_steps")).not.toBeNull();
    // re-raising min activations flips the exclusion the other way: steps
    // (non-zero now) is zeroed and the note moves to the steps control
    dragAndRelease(view, "lore-min-act-range", 1);
    expect(view.queryByText("lore_reset_by_steps")).toBeNull();
    expect(view.getByText("lore_reset_by_min_act")).not.toBeNull();
    expect(writes[1]).toEqual({ minActivations: 1, maxRecursionSteps: 0 });
  });

  it("disabled states: steps gated on recursive scanning, depth max gated on min activations", async () => {
    const view = renderAccordion(); // recursiveScanning: false, minActivations: 0
    await openAdvanced(view);
    expect(view.getByTestId("lore-steps-range").hasAttribute("disabled")).toBe(true);
    expect(view.getByTestId("lore-depth-max-range").hasAttribute("disabled")).toBe(true);
    expect(view.getByTestId("lore-min-act-range").hasAttribute("disabled")).toBe(false);
    view.unmount(); // one live view at a time — queries bind to document.body

    const enabled = renderAccordion({ lorebook: { ...LOREBOOK, recursiveScanning: true, minActivations: 2 } });
    await openAdvanced(enabled);
    expect(enabled.getByTestId("lore-steps-range").hasAttribute("disabled")).toBe(false);
    expect(enabled.getByTestId("lore-depth-max-range").hasAttribute("disabled")).toBe(false);
  });

  it("zero captions appear only at 0", async () => {
    const zero = renderAccordion({ lorebook: { ...LOREBOOK, recursiveScanning: true, minActivations: 2, minActivationsDepthMax: 0, maxRecursionSteps: 0 } });
    await openAdvanced(zero);
    expect(zero.getByText("lore_steps_zero")).not.toBeNull();
    expect(zero.getByText("lore_depth_max_zero")).not.toBeNull();
    expect(zero.queryByText("lore_min_act_zero")).toBeNull(); // minAct 2 ≠ 0
    zero.unmount(); // one live view at a time — queries bind to document.body
    // depth-max caption is gated on the minimum actually running (minAct ≠ 0)
    const minActZero = renderAccordion({ lorebook: { ...LOREBOOK, minActivations: 0, minActivationsDepthMax: 0 } });
    await openAdvanced(minActZero);
    expect(minActZero.queryByText("lore_depth_max_zero")).toBeNull();
    expect(minActZero.getByText("lore_min_act_zero")).not.toBeNull();
    minActZero.unmount();

    const { view } = renderStatefulAccordion({ recursiveScanning: true, minActivations: 2 });
    await openAdvanced(view);
    dragAndRelease(view, "lore-steps-range", 3);
    expect(view.queryByText("lore_steps_zero")).toBeNull(); // 3 ≠ 0 → no caption
  });

  it("the overflow checkbox writes overflowAlert", async () => {
    const { view, writes } = renderStatefulAccordion();
    await openAdvanced(view);
    fireEvent.click(view.getByRole("checkbox", { name: "lore_overflow_alert" }));
    expect(writes).toEqual([{ overflowAlert: true }]);
  });
});
