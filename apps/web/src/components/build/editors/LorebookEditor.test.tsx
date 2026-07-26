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
 * Runner: bun:test with scoped happy-dom cleanup. Module mocks preserve every
 * unmodified real export because they are process-global within the test process.
 *
 * Heavy subtrees (LoreEntryEditor, LorebookAccordion, LorebookImportModal,
 * useScriptPanel) are stubbed to lightweight components that fire the parent's
 * REAL callbacks — this isolates the parent's state logic (the extraction
 * target), not the children's rendering. The stubbed LoreEntryEditor writes
 * directly to the lifted RHF form, and the stubbed LorebookAccordion calls
 * `onEntryClick`, so the autosave + entry-loading contracts exercise the
 * genuine code paths.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ReactNode } from "react";
import { mocked } from "../../../../test/mock-utils.js";
import type { LoreEntryRecord, LorebookRecord } from "../../../app-client.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

// ── Module-boundary mocks ─────────────────────────────────────────────────

const realI18nContext = await import("../../../i18n/context.js");
const realSonner = await import("sonner");
const realTooltip = await import("../../shared/Tooltip.js");
const realLorebookImportModal = await import("./LorebookImportModal.js");
const realScriptEditor = await import("./ScriptEditor.js");
const realReactHookForm = await import("react-hook-form");
const realLoreEntryEditor = await import("./LoreEntryEditor.js");
const realLorebookAccordion = await import("./LorebookAccordion.js");
const realSnapshotStore = await import("../../../stores/snapshot-store.js");
const realBootstrapActions = await import("../../../stores/api-actions/bootstrap-actions.js");
const realAppClient = await import("../../../app-client.js");

const toastSuccess = mock();
const toastError = mock();
const toastInfo = mock();
const listAllLorebooks = mock(realAppClient.listAllLorebooks);
const listLorebooks = mock(realAppClient.listLorebooks);
const listLoreEntries = mock(realAppClient.listLoreEntries);
const getLorebookLinks = mock(realAppClient.getLorebookLinks);
const updateLoreEntry = mock(realAppClient.updateLoreEntry);
const createLoreEntry = mock(realAppClient.createLoreEntry);

// Identity i18n — assertion strings match the i18n keys verbatim.
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

// sonner toasts — stubbed so the duplicate test can assert success feedback
// fires (the whole point of the toast: the duplicate must not be silent).
mock.module("sonner", () => ({
  ...realSonner,
  toast: {
    ...realSonner.toast,
    success: toastSuccess,
    error: toastError,
    info: toastInfo,
  },
}));

// CustomTooltip needs a Radix TooltipProvider context irrelevant here;
// passthrough children, drop the `content` prop (labels not needed via tooltip).
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// Heavy modal — irrelevant to the parent's state; render nothing.
mock.module("./LorebookImportModal.js", () => ({
  ...realLorebookImportModal,
  LorebookImportModal: () => null,
}));

// Script panel — isolate from the scripts concern entirely. Provides every
// member LorebookEditor reads off `scriptPanel`.
mock.module("./ScriptEditor.js", () => ({
  ...realScriptEditor,
  useScriptPanel: () => ({
    modals: null,
    scriptListContent: null,
    scriptEditorPanel: null,
    setActiveScriptId: () => {},
    handleAdd: () => {},
    handleImportOpen: () => {},
  }),
}));

// Entry editor — stub to a single field that writes to the lifted RHF form
// (the autosave entry point: every real field binds via register /
// ControlledField, so the stub mimics that by writing directly to the form it
// receives through <FormProvider>). The real LoreEntryEditor pulls Radix
// popovers / TokenCounter / AiAssistantModal — irrelevant to the parent's
// dirty+debounce logic and too heavy for happy-dom. The factory closes over
// the real React Hook Form export captured before module registration.
mock.module("./LoreEntryEditor.js", () => {
  const { useFormContext } = realReactHookForm;
  return {
    ...realLoreEntryEditor,
    LoreEntryEditor: (props: { onDuplicate: () => void }) => {
      const form = useFormContext();
      // Reactive title — lets the duplicate test assert the editor stayed
      // mounted on the COPY (activeEntry resolved) rather than falling through
      // to the script-panel fallback (activeEntry null → stub unmounts).
      const title = form?.watch?.("title") ?? "";
      return (
        <>
          <span data-testid="active-title">{title}</span>
          <input
            data-testid="entry-field"
            onChange={(e) => form?.setValue("title", e.currentTarget.value, { shouldDirty: true })}
          />
          {/* Duplicate trigger — exercises the in-editor entry switch (the
              autosave flush-on-switch invariant), which the accordion entry-click
              path can't reach (the list unmounts on view "editor"). */}
          <button data-testid="duplicate-btn" onClick={props.onDuplicate} />
        </>
      );
    },
  };
});

// Lorebook accordion — stub to a row that (a) renders the lorebook name and
// (b) fires onEntryClick with a fixed entry id, so the parent's entry-loading
// + editor-view logic is exercised for real. NOTE: LorebookEditor binds
// onEntryClick={(entryId) => handleEntryClick(lb.id, entryId)} — the lorebook
// id is CLOSED OVER in the parent; the callback takes ONLY entryId.
mock.module("./LorebookAccordion.js", () => ({
  ...realLorebookAccordion,
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

mock.module("../../../stores/snapshot-store.js", () => ({
  ...realSnapshotStore,
  useAllCharacters: () => [],
}));

mock.module("../../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrapActions,
  useBootstrapStore: () => [],
}));

// app-client (barrel) — override the lorebook/entry functions the parent calls;
// spread the real module so every other re-export stays intact for any
// transitive consumer. Tests bind the concrete native mocks directly.
mock.module("../../../app-client.js", () => ({
  ...realAppClient,
  listAllLorebooks,
  listLorebooks,
  listLoreEntries,
  getLorebookLinks,
  updateLoreEntry,
  createLoreEntry,
}));

let LorebookEditor: typeof import("./LorebookEditor.js").LorebookEditor;
beforeAll(async () => {
  ({ LorebookEditor } = await import("./LorebookEditor.js"));
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
 * Ensure sessionStorage is functional. Native web storage can leave both
 * Storage globals as undefined getters; LorebookEditor reads/writes
 * sessionStorage for the sticky tab, so guard it here.
 */
function ensureSessionStorage(): void {
  if (typeof window.sessionStorage?.getItem === "function") return;
  const store = new Map<string, string>();
  Object.defineProperty(window, "sessionStorage", {
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
    mock.clearAllMocks();
    ensureSessionStorage();
    sessionStorage.clear();
    setViewport(1024); // desktop by default

    mocked(listAllLorebooks).mockResolvedValue([makeLorebook()]);
    mocked(listLorebooks).mockResolvedValue([makeLorebook()]);
    mocked(listLoreEntries).mockResolvedValue([makeEntry()]);
    mocked(getLorebookLinks).mockResolvedValue([]);
    mocked(updateLoreEntry).mockResolvedValue(makeEntry());
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

    // The autosave indicator reflects savingState / form.formState.isDirty
    // via a data-state attr (idle | pending | saving | saved | error).
    const indicator = () =>
      container.querySelector('[data-testid="autosave-indicator"]');
    // Before any edit: idle (indicator faded out).
    expect(indicator()?.getAttribute("data-state")).toBe("idle");

    // Edit the field → the stub writes form.setValue("title", …, { shouldDirty: true })
    // (dirty immediately) + the mirror re-arms the 1s debounce.
    fireEvent.change(getByTestId("entry-field"), { target: { value: "Hobgoblin" } });

    // Dirty is observable immediately: form.formState.isDirty → "pending".
    await waitFor(() => {
      expect(indicator()?.getAttribute("data-state")).toBe("pending");
    });

    // After the debounce, flushSave fires updateLoreEntry with exactly the
    // dirty field (not the whole entry) — the partial-dirty contract.
    await waitFor(() => {
      expect(updateLoreEntry).toHaveBeenCalledWith(LB_ID, ENTRY_ID, { title: "Hobgoblin" });
    }, { timeout: 2500 });
    // One edit → exactly one save (the debounce coalesces, no double-fire).
    expect(updateLoreEntry).toHaveBeenCalledTimes(1);

    // Dirty cleared after the flush (form.reset) → indicator leaves "pending".
    await waitFor(() => {
      expect(indicator()?.getAttribute("data-state")).not.toBe("pending");
    });
  });

  it("duplicate: creates a copy, persists the source's pending edit, and opens the copy", async () => {
    // Stateful list mock: the backend doesn't have entry-2 until createLoreEntry
    // succeeds, so listLoreEntries returns [entry-1] before the create and
    // [entry-1, entry-2] after. This pins the real stale-entries failure mode:
    // without the post-create refreshEntries, the copy never enters `entries`,
    // activeEntry resolves to null, and the editor falls through to the script
    // panel (a blank screen until a full page reload) — which the active-title
    // assertion at the end catches.
    let created = false;
    mocked(createLoreEntry).mockImplementation(async (_lb, fields) => {
      created = true;
      return makeEntry({ id: "entry-2", ...(fields as Partial<LoreEntryRecord>) });
    });
    mocked(listLoreEntries).mockImplementation(async () =>
      created
        ? [makeEntry(), makeEntry({ id: "entry-2", title: "Hobgoblin" })]
        : [makeEntry()],
    );
    mocked(updateLoreEntry).mockImplementation(async (_lb, entryId, patch) =>
      makeEntry({ id: entryId, ...(patch as Partial<LoreEntryRecord>) }),
    );
    const { getByTestId, queryByTestId } = await renderAtList();
    fireEvent.click(getByTestId("entry-click")); // load entry-1
    await waitFor(() => expect(getByTestId("active-title")).toBeTruthy());
    // Edit the source entry (arms the 1s debounce).
    fireEvent.change(getByTestId("entry-field"), { target: { value: "Hobgoblin" } });
    // Duplicate — flushes entry-1's edit, refetches (entry-2 now in entries),
    // then creates + selects the copy.
    fireEvent.click(getByTestId("duplicate-btn"));
    // The copy is created from the current (edited) state, minus identity fields.
    await waitFor(() => expect(createLoreEntry).toHaveBeenCalledTimes(1));
    const createCall = mocked(createLoreEntry).mock.calls[0];
    if (createCall === undefined) throw new Error("Expected the duplicate to create an entry");
    const [, fields] = createCall;
    expect(fields.title).toBe("Hobgoblin");
    expect(fields).not.toHaveProperty("id");
    expect(fields).not.toHaveProperty("sortOrder");
    // The source's pending edit was flushed before the switch — not lost.
    await waitFor(() => {
      expect(updateLoreEntry).toHaveBeenCalledWith(LB_ID, "entry-1", { title: "Hobgoblin" });
    });
    // The editor now shows the COPY (activeEntry resolved to entry-2 — not the
    // script-panel fallback). Without the refreshEntries fix activeEntry is
    // null and the stub unmounts, so active-title disappears.
    await waitFor(() => {
      expect(queryByTestId("active-title")).not.toBeNull();
    });
    // Success toast fires — the duplicate is NOT silent (the copy looks
    // identical to the source, so without explicit feedback the user can't
    // tell they're on the copy).
    expect(toastSuccess).toHaveBeenCalledWith("lore_entry_duplicated");
  });
});
