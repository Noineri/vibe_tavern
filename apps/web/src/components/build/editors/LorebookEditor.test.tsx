/**
 * LorebookEditor — characterization tests.
 *
 * Safety net for LOREBOOK_EDITOR_GOD_OBJECT_AUDIT Step 2, which extracts a
 * `useLorebookEditorState` controller hook (data + navigation concerns) out of
 * this 1138-line component. These tests pin the OBSERVABLE behaviors that the
 * extraction must preserve, so a regression (dropped setter, stale-closure
 * ref, wrong effect dep array) fails loudly instead of silently shipping:
 *
 *   - view-transition: pick view is the default; clicking a card navigates to
 *     the list view (handlePick, the 260ms transition chain);
 *   - data-loading: the list view loads lorebooks (listAllLorebooks for scope
 *     "all"; listLorebooks(scope, ownerId) otherwise); switching scope re-fetches;
 *   - entry-loading: selecting an entry loads its lorebook's entries;
 *   - autosave: editing a field debounces (1s) a single updateLoreEntry with
 *     exactly the dirty field, then clears dirty (form.formState.dirtyFields / isDirty).
 *
 * Runner: vitest (apps/web uses vitest, NOT bun:test — see vitest.config.ts;
 * the mock.module/bunfig gotchas in AGENTS.md don't apply here; vi.mock is
 * file-scoped and hoisted). DOM via happy-dom (per-file, configured globally).
 *
 * Heavy subtrees (LoreEntryEditor, LorebookAccordion, LorebookImportModal,
 * useScriptPanel) are stubbed to lightweight components that fire the parent's
 * REAL callbacks — this isolates the parent's state logic (the extraction
 * target), not the children's rendering. The stubbed LoreEntryEditor calls
 * `updateAct`, and the stubbed LorebookAccordion calls `onEntryClick`, so the
 * autosave + entry-loading contracts exercise the genuine code paths.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import {
  listAllLorebooks,
  listLorebooks,
  listLoreEntries,
  getLorebookLinks,
  updateLoreEntry,
  type LoreEntryRecord,
  type LorebookRecord,
} from "../../../app-client.js";
import { LorebookEditor } from "./LorebookEditor.js";

// ── Module-boundary mocks (hoisted above the import of LorebookEditor) ─────

// Identity i18n — assertion strings match the i18n keys verbatim.
vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// CustomTooltip needs a Radix TooltipProvider context irrelevant here;
// passthrough children, drop the `content` prop (labels not needed via tooltip).
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// Heavy modal — irrelevant to the parent's state; render nothing.
vi.mock("./LorebookImportModal.js", () => ({
  LorebookImportModal: () => null,
}));

// Script panel — isolate from the scripts concern entirely. Provides every
// member LorebookEditor reads off `scriptPanel`.
vi.mock("./ScriptEditor.js", () => ({
  useScriptPanel: () => ({
    modals: null,
    scriptListContent: null,
    scriptEditorPanel: null,
    setActiveScriptId: () => {},
    handleAdd: () => {},
    handleImportOpen: () => {},
  }),
}));

// Entry editor — stub to a single field that fires updateAct (the autosave
// entry point). The real LoreEntryEditor pulls Radix popovers / TokenCounter /
// AiAssistantModal — irrelevant to the parent's dirty+debounce logic and too
// heavy for happy-dom.
vi.mock("./LoreEntryEditor.js", () => ({
  LoreEntryEditor: (props: {
    updateAct: (field: string, value: unknown) => void;
  }) => (
    <input
      data-testid="entry-field"
      onChange={(e) => props.updateAct("title", e.target.value)}
    />
  ),
}));

// Lorebook accordion — stub to a row that (a) renders the lorebook name and
// (b) fires onEntryClick with a fixed entry id, so the parent's entry-loading
// + editor-view logic is exercised for real. NOTE: LorebookEditor binds
// onEntryClick={(entryId) => handleEntryClick(lb.id, entryId)} — the lorebook
// id is CLOSED OVER in the parent; the callback takes ONLY entryId.
vi.mock("./LorebookAccordion.js", () => ({
  LorebookAccordion: (props: {
    lorebook: { id: string; name: string };
    onEntryClick: (entryId: string) => void;
  }) => (
    <div data-testid="lb-accordion">
      <span data-testid="lb-name">{props.lorebook.name}</span>
      <button
        data-testid="entry-click"
        onClick={() => props.onEntryClick("entry-1")}
      />
    </div>
  ),
}));

vi.mock("../../../stores/snapshot-store.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../../stores/snapshot-store.js");
  return { ...real, useAllCharacters: () => [] };
});

vi.mock("../../../stores/api-actions/bootstrap-actions.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../../stores/api-actions/bootstrap-actions.js");
  return { ...real, useBootstrapStore: () => [] };
});

// app-client (barrel) — override the lorebook/entry functions the parent calls;
// spread the real module so every other re-export stays intact for any
// transitive consumer. The hoisted-import trick: the named imports below
// resolve to these vi.fn() instances (vi.mock is hoisted above the import).
vi.mock("../../../app-client.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../../app-client.js");
  return {
    ...real,
    listAllLorebooks: vi.fn(),
    listLorebooks: vi.fn(),
    listLoreEntries: vi.fn(),
    getLorebookLinks: vi.fn(),
    updateLoreEntry: vi.fn(),
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────

const LB_ID = "lb-1";
const ENTRY_ID = "entry-1";
const CHARACTER_ID = "char-1";

function makeLorebook(over: Partial<LorebookRecord> = {}): LorebookRecord {
  return {
    id: LB_ID,
    name: "Bestiary",
    description: "",
    scopeType: "character",
    characterId: CHARACTER_ID,
    personaId: null,
    chatId: null,
    scanDepth: 4,
    tokenBudget: 2048,
    tokenBudgetPercent: null,
    recursiveScanning: false,
    enabled: true,
    ...over,
  };
}

function makeEntry(over: Partial<LoreEntryRecord> = {}): LoreEntryRecord {
  return {
    id: ENTRY_ID,
    lorebookId: LB_ID,
    title: "Goblin",
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

/** Set the viewport width (the inline useIsMobile reads window.innerWidth). */
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
}

/**
 * Ensure sessionStorage is functional. vitest-setup shims only localStorage
 * (Node 24.6+ native-webstorage can leave both Storage globals as undefined
 * getters); LorebookEditor reads/writes sessionStorage for the sticky tab, so
 * guard it here. No-op when happy-dom already provides a working one.
 */
function ensureSessionStorage(): void {
  const w = window as unknown as { sessionStorage?: Storage };
  if (w.sessionStorage && typeof w.sessionStorage.getItem === "function") return;
  const store = new Map<string, string>();
  Object.defineProperty(w, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
  });
}

/** Render + navigate pick → list (click the Lorebooks card; handlePick runs). */
async function renderAtList(props?: { characterId?: string; chatId?: string | null; personaId?: string | null }) {
  const utils = render(
    <LorebookEditor
      characterId={props?.characterId ?? CHARACTER_ID}
      chatId={props?.chatId ?? null}
      personaId={props?.personaId ?? null}
    />,
  );
  // Pick view → click the Lorebooks card → the exit animation's
  // onAnimationEnd (lbFadeOut) advances the event-driven phase machine to
  // view "list", which fires the load effect (listAllLorebooks). happy-dom
  // does not run CSS animations, so drive onAnimationEnd explicitly.
  fireEvent.click(utils.getByText("lorebooks_card_title"));
  fireEvent.animationEnd(utils.getByText("lorebooks_card_title"));
  await waitFor(() => expect(listAllLorebooks).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(utils.getByTestId("lb-name").textContent).toBe("Bestiary"));
  return utils;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("LorebookEditor (characterization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureSessionStorage();
    sessionStorage.clear();
    setViewport(1024); // desktop by default

    vi.mocked(listAllLorebooks).mockResolvedValue([makeLorebook()]);
    vi.mocked(listLorebooks).mockResolvedValue([makeLorebook()]);
    vi.mocked(listLoreEntries).mockResolvedValue([makeEntry()]);
    vi.mocked(getLorebookLinks).mockResolvedValue([]);
    vi.mocked(updateLoreEntry).mockResolvedValue(makeEntry());
  });

  it("view-transition: pick view is the default — renders both cards, no list", () => {
    const { getByText } = render(
      <LorebookEditor characterId={CHARACTER_ID} chatId={null} personaId={null} />,
    );
    // Both cards present (identity-t mock → i18n keys verbatim).
    expect(getByText("lorebooks_card_title")).toBeTruthy();
    expect(getByText("scripts_card_title")).toBeTruthy();
    // Pick view renders NO accordion list.
    expect(document.querySelector('[data-testid="lb-accordion"]')).toBeNull();
    // And the load effect does not fire while still on the pick view.
    expect(listAllLorebooks).not.toHaveBeenCalled();
  });

  it("data-loading: clicking the Lorebooks card navigates to list and loads all lorebooks", async () => {
    const { getByTestId } = await renderAtList();
    // scope defaults to "all" → the dedicated listAllLorebooks endpoint is used.
    expect(listAllLorebooks).toHaveBeenCalledTimes(1);
    expect(listLorebooks).not.toHaveBeenCalled();
    // The loaded lorebook drives the accordion list.
    expect(getByTestId("lb-name").textContent).toBe("Bestiary");
  });

  it("data-loading: switching scope re-fetches via listLorebooks(scope, ownerId)", async () => {
    // Mobile viewport so the scope chip bar renders its labels (the desktop
    // scope column shows only icons — labels live in the tooltip `content`).
    setViewport(375);
    const { getByText } = await renderAtList();

    fireEvent.click(getByText("scope_char"));

    await waitFor(() => {
      expect(listLorebooks).toHaveBeenCalledWith("character", CHARACTER_ID);
    });
  });

  it("entry-loading: selecting an entry loads its lorebook's entries via listLoreEntries", async () => {
    const { getByTestId } = await renderAtList();

    fireEvent.click(getByTestId("entry-click"));

    await waitFor(() => {
      // handleEntryClick sets activeLorebookIdForEntry → the entries effect
      // fires listLoreEntries for that lorebook.
      expect(listLoreEntries).toHaveBeenCalledWith(LB_ID);
    });
  });

  it("autosave: a field edit debounces a single updateLoreEntry with the dirty field, then clears dirty", async () => {
    const { getByTestId, container } = await renderAtList();

    // Navigate into the entry editor (handleEntryClick → view "editor").
    fireEvent.click(getByTestId("entry-click"));
    // Entries load → activeEntry resolves → stubbed editor renders.
    await waitFor(() => expect(getByTestId("entry-field")).toBeTruthy());

    // In editor view the only <button> is the editor-header autosave indicator;
    // its text reflects savingState / form.formState.isDirty (identity-t → i18n keys).
    const autosaveBtn = () => container.querySelector("button");
    // Before any edit: idle (NOT the dirty "save entry" affordance).
    expect(autosaveBtn()?.textContent ?? "").not.toBe("lore_save_entry");

    // Edit the field → updateAct marks dirty + schedules the 1s debounce.
    fireEvent.change(getByTestId("entry-field"), { target: { value: "Hobgoblin" } });

    // Dirty is observable immediately: form.formState.isDirty → "save entry".
    await waitFor(() => {
      expect(autosaveBtn()?.textContent).toBe("lore_save_entry");
    });

    // After the debounce, flushSave fires updateLoreEntry with exactly the
    // dirty field (not the whole entry) — the partial-dirty contract.
    await waitFor(() => {
      expect(updateLoreEntry).toHaveBeenCalledWith(LB_ID, ENTRY_ID, { title: "Hobgoblin" });
    }, { timeout: 2500 });
    // One edit → exactly one save (the debounce coalesces, no double-fire).
    expect(updateLoreEntry).toHaveBeenCalledTimes(1);

    // Dirty cleared after the flush → no longer the dirty affordance.
    await waitFor(() => {
      expect(autosaveBtn()?.textContent).not.toBe("lore_save_entry");
    });
  });
});
