/**
 * CoauthorRail tests.
 *
 * 1. Provider entry routing (E3, MOBILE_DEFECTS_ROUND_2). The co-author
 *    surface has its OWN provider modal (CoauthorProviderModal — tool-filtered
 *    model list, co-author binding, mobile MasterDetail shell). The rail's plug
 *    button used to open the shared RP ProviderModal instead, so "provider
 *    settings" inside a co-author chat showed the RP chat's provider — the
 *    reported defect. Pins BOTH rail surfaces (collapsed strip Ico + expanded
 *    drawer NavRow): the plug must raise the co-author modal flag and must NOT
 *    raise the RP one.
 *
 * 2. The expanded drawer (RAIL_DRILL_IN RD-4). The first describe was
 *    CHARACTERIZED against the inline rail that existed before the drill-in
 *    (character rows with ⋮, the selected character's chats below the row, a
 *    «New chat» row) and passed unchanged on that code; its assertions are about
 *    EFFECTS — modal flag, picker call, list contents, the controller call,
 *    whether the drawer stays open — so they hold across the move. Only the
 *    locator helpers changed when controls moved: the character ⋮ went from the
 *    row to the screen-2 header, «New chat» from a row under the chats to the
 *    header «+», create / import from a grid to the screen-1 header buttons. The
 *    remaining describes are the drill-in itself, the Co-Author mode bucket and
 *    the absence of branch UI.
 *
 * Stores render with real defaults / seeded data (no network); useT and
 * CustomTooltip are mocked at their module boundary with the `...real` spread
 * (keys verbatim, a `count` option appended as `key#count`, so the plural-key
 * call is observable; the Radix tooltip needs a provider the isolated render
 * lacks). The two controllers are spies for the actions the rail triggers and
 * the mobile import orchestrator is a ref-contract double (`openPicker`).
 *
 * Happy-dom never completes Base UI's exit transition, so a closed drawer stays
 * mounted — which exercises the «every open» rule through the same instance
 * (`open` false→true) the quick-reopen case has in the browser.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { forwardRef, useImperativeHandle } from "react";
import { brandId, normalizeAutoSummaryConfig, normalizeInsightsConfig, normalizeObjectiveState, type ChatBranch, type ChatBranchId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../api/types.js";
import type { CharacterImportMobileHandle } from "../modals/import/CharacterImportMobile.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireCharacter, wireUiSettings } from "../../../test/wire-fixtures.js";
import { formatRelativeTime } from "../layout/sidebar-utils.js";

useDomEnv();
const { act, fireEvent, render, within } = await import("@testing-library/react");
const { createElement } = await import("react");

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, opts?: { count?: number }) => (typeof opts?.count === "number" ? `${key}#${opts.count}` : key),
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// Radix Tooltip (ListSortToggle and friends inside the drawer) needs a
// TooltipProvider ancestor the isolated render lacks — passthrough stub,
// same pattern as CoauthorTopBar.test.tsx.
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const renameChatSpy = mock(async (_chatId: ChatId, _title: string): Promise<void> => {});
const switchChatSpy = mock(async (_chatId: ChatId): Promise<void> => {});
const createChatSpy = mock(async (_characterId?: string, _mode?: string): Promise<void> => {});
const exportCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const duplicateCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const deleteCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const NOOP_ASYNC = async () => {};

const CHAT_STUB = { handleSwitchChat: switchChatSpy };
const CHARACTER_STUB = {
  handleCreateChat: createChatSpy,
  handleExportCharacter: exportCharacterSpy,
  handleDuplicateCharacter: duplicateCharacterSpy,
  handleDeleteCharacter: deleteCharacterSpy,
  handleExportChatJsonl: NOOP_ASYNC,
  handleRemoveChat: NOOP_ASYNC,
  handleRenameChat: renameChatSpy,
  handleImportFiles: NOOP_ASYNC,
  getChatRemovalMode: () => "delete" as const,
  isImporting: false,
};

const realChatController = await import("../../hooks/use-chat-controller.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => CHAT_STUB,
}));
const realCharacterController = await import("../../hooks/use-character-controller.js");
mock.module("../../hooks/use-character-controller.js", () => ({
  ...realCharacterController,
  useCharacterController: () => CHARACTER_STUB,
}));

// The orchestrator is an always-mounted child the rail drives through a ref;
// the double keeps the ref contract (`openPicker`) and renders nothing.
const openCharacterPicker = mock((): void => {});
const realCharacterImport = await import("../modals/import/CharacterImportMobile.js");
mock.module("../modals/import/CharacterImportMobile.js", () => ({
  ...realCharacterImport,
  CharacterImportMobile: forwardRef<CharacterImportMobileHandle, object>(function CharacterImportDouble(_props, ref) {
    useImperativeHandle(ref, () => ({ openPicker: openCharacterPicker }));
    return null;
  }),
}));

const { CoauthorRail } = await import("./CoauthorRail.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { useChatStore, useModalStore, useNavigationStore } = await import("../../stores/index.js");
const { useCharacterStore } = await import("../../stores/character-store.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");

const resetModals = () =>
  useModalStore.setState({ isCoauthorProviderModalOpen: false, isProviderModalOpen: false, isCoauthorModuleModalOpen: false, isCoauthorSkillModalOpen: false });

describe("CoauthorRail — plug routes to the co-author provider modal (E3)", () => {
  beforeEach(resetModals);

  it("collapsed strip: Ico plug opens the co-author modal, not the RP one", () => {
    const { getByTitle } = render(createElement(CoauthorRail));
    fireEvent.click(getByTitle("provider_settings_tooltip"));
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(true);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
  });

  it("expanded drawer: NavRow plug opens the co-author modal, not the RP one", async () => {
    const { findByText } = render(createElement(CoauthorRail));
    // Open the drawer the way TopBar's hamburger does — bump the nav store's
    // force-open counter; the rail's effect sets `expanded` for us. Flush via
    // act so the effect + Base UI portal mount before we query.
    act(() => {
      useNavigationStore.setState({ railForceOpen: (useNavigationStore.getState().railForceOpen ?? 0) + 1 });
    });
    // The drawer popup renders the NavRow cluster (portalled); the NavRow's
    // label is a text node (the collapsed-strip Ico carries a title ATTRIBUTE,
    // so a text query is unambiguous for the drawer row).
    const label = await findByText("provider_settings_tooltip");
    const row = label.closest("div.cursor-pointer") as HTMLElement | null;
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(true);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────

const ARIA = "char-aria";
const BRAM = "char-bram";
const CORA = "char-cora";
const CHAT_A1 = brandId<ChatId>("chat-a1");
const CHAT_A2 = brandId<ChatId>("chat-a2");
const CHAT_A3 = brandId<ChatId>("chat-a3");
const CHAT_B1 = brandId<ChatId>("chat-b1");
const CHAT_B2 = brandId<ChatId>("chat-b2");
const CHAT_C1 = brandId<ChatId>("chat-c1");
const BR_ROOT = brandId<ChatBranchId>("br-root");
const BR_ALT = brandId<ChatBranchId>("br-alt");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function makeEntry(id: string, name: string, tags: string[]): AppCharacterEntry {
  return {
    id,
    name,
    subtitle: "",
    tags,
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function makeChat(id: ChatId, characterId: string, title: string, over: Partial<ChatListItem> = {}): ChatListItem {
  const stamp = over.updatedAt ?? ago(DAY);
  return {
    id,
    title,
    characterId: brandId<CharacterId>(characterId),
    characterName: "",
    subtitle: `${title} subtitle`,
    activeBranchLabel: "",
    mode: "coauthor",
    messageCount: 4,
    lastMessageAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function makeBranch(id: ChatBranchId, label: string, parentBranchId: ChatBranchId | null): ChatBranch {
  return { id, chatId: CHAT_A1, parentBranchId, forkedFromMessageId: null, label, createdAt: "2026-01-01T00:00:00Z" } as ChatBranch;
}

const CHARACTERS = [makeEntry(ARIA, "Aria", ["fantasy"]), makeEntry(BRAM, "Bram", ["scifi"]), makeEntry(CORA, "Cora", ["fantasy", "scifi"])];

/**
 * Aria: two Co-Author chats (newest 5 min ago) plus a newer RP chat the
 * Co-Author rail must not list or count; Bram: one Co-Author chat (1 min ago)
 * and one RP chat; Cora: only an RP chat, so no Co-Author chat at all.
 */
function chatRows(): ChatListItem[] {
  return [
    makeChat(CHAT_A1, ARIA, "Draft Outline", { updatedAt: ago(5 * MIN), messageCount: 12 }),
    makeChat(CHAT_A2, ARIA, "Second Pass", { updatedAt: ago(2 * DAY) }),
    makeChat(CHAT_A3, ARIA, "Moonlit Harbor", { mode: "rp", updatedAt: ago(10_000) }),
    makeChat(CHAT_B1, BRAM, "Station Notes", { updatedAt: ago(MIN) }),
    makeChat(CHAT_B2, BRAM, "Station Nine", { mode: "rp", updatedAt: ago(20_000) }),
    makeChat(CHAT_C1, CORA, "Tavern Night", { mode: "rp" }),
  ];
}

/**
 * The chat list is loaded and a Co-Author chat (Aria's «Draft Outline») is
 * active — the only state this rail mounts in. `snapshotCharacter: false` leaves
 * the snapshot's character unloaded (the chat meta is then null while the chat
 * list is still there).
 */
function seedStores(opts: { selectedCharacterId?: string | null; snapshotCharacter?: boolean } = {}): void {
  const chats = chatRows();
  const active = chats.find((c) => c.id === CHAT_A1);
  if (!active) throw new Error("no seeded active chat");
  useNavigationStore.setState({ mode: "play", characterSortMode: "recent", chatSortMode: "recent", railForceOpen: 0 });
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: CHARACTERS,
      promptPresets: [],
      uiSettings: wireUiSettings(),
      agentKindSettings: {},
      isArmServer: false,
    },
  });
  useChatStore.setState({ activeChatId: CHAT_A1, selectedCharacterId: opts.selectedCharacterId ?? null });
  useModalStore.setState({ isCreateCharacterModalOpen: false });
  useCharacterStore.setState({ confirmDestroy: null });
  useSnapshotStore.setState({
    character: opts.snapshotCharacter === false ? null : { ...wireCharacter(), id: active.characterId, name: "Aria" },
    persona: null,
    allCharacters: CHARACTERS,
    chatIds: chats.map((c) => c.id),
    chatsById: Object.fromEntries(chats.map((c) => [c.id, c])),
    activeChat: {
      id: active.id,
      characterId: active.characterId,
      personaId: null,
      title: active.title,
      status: "active",
      mode: "coauthor",
      activeBranchId: BR_ROOT,
      promptPresetId: null,
      selectedGreetingIndex: 0,
      coauthorContextLinks: [],
      coauthorModuleId: null,
      dynamicPrompt: "",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      summary: "",
      messageHistoryLimit: 0,
      autoSummaryConfig: normalizeAutoSummaryConfig(undefined),
      insightsConfig: normalizeInsightsConfig(undefined),
      insightsObjectiveState: normalizeObjectiveState(undefined),
    },
    // The snapshot carries branches for the active chat; the Co-Author rail must not surface them.
    activeBranch: makeBranch(BR_ROOT, active.title, null),
    branches: [makeBranch(BR_ROOT, active.title, null), makeBranch(BR_ALT, "Side thread", BR_ROOT)],
  });
}

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Render the rail and open its drawer the way the TopBar hamburger does. */
function openRail(opts: Parameters<typeof seedStores>[0] = {}): View {
  seedStores(opts);
  const view = render(createElement(CoauthorRail));
  openDrawer();
  return view;
}

function openDrawer(): void {
  act(() => {
    useNavigationStore.setState({ railForceOpen: useNavigationStore.getState().railForceOpen + 1 });
  });
}

/** The expanded drawer panel (the collapsed strip lives outside it). */
function drawer(view: View): HTMLElement {
  const popup = view.baseElement.querySelector<HTMLElement>(".rail-popup");
  if (!popup) throw new Error("the rail drawer is not mounted");
  return popup;
}

/** Whether the drawer is open (Base UI drops data-open from a closing popup). */
function drawerIsOpen(view: View): boolean {
  return drawer(view).hasAttribute("data-open");
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}

function inDrawer<T extends HTMLElement>(view: View, selector: string): T {
  const el = drawer(view).querySelector<T>(selector);
  if (!el) throw new Error(`nothing in the drawer matches ${selector}`);
  return el;
}

// ── Locators: the only part that moves with the drawer's markup ──────────

const CHARACTER_NAMES = CHARACTERS.map((c) => c.name);

/** The drawer's heading (Drawer.Title): the screen-1 title or the character's name. */
function screenTitle(view: View): string {
  return textOf(drawer(view).querySelector("h2"));
}

/** Screen 2 is showing when the header has its back arrow. */
function onCharacterScreen(view: View): boolean {
  return drawer(view).querySelector('button[aria-label="back"]') !== null;
}

const backButton = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="back"]');

/** Screen 1 — go back from a character's screen if that is where the drawer opened. */
function showCharacterList(view: View): void {
  if (onCharacterScreen(view)) fireEvent.click(backButton(view));
}

/** Render, open, and make sure the character list (screen 1) is showing. */
function openRailOnList(opts: Parameters<typeof seedStores>[0] = {}): View {
  const view = openRail(opts);
  showCharacterList(view);
  return view;
}

/** Character names listed on screen 1, in document order. */
function listedCharacters(view: View): string[] {
  const root = drawer(view);
  const hits: { name: string; el: Element }[] = [];
  for (const name of CHARACTER_NAMES) {
    for (const el of root.querySelectorAll("span")) {
      if (el.childElementCount === 0 && el.textContent === name) hits.push({ name, el });
    }
  }
  hits.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return hits.map((h) => h.name);
}

/** The character row (tap target) for `name` on screen 1. */
function characterRow(view: View, name: string): HTMLElement {
  const label = [...drawer(view).querySelectorAll("span")].find((el) => el.childElementCount === 0 && el.textContent === name);
  const row = label?.closest<HTMLElement>("button");
  if (!row) throw new Error(`no character row for "${name}"`);
  return row;
}

/** Line 2 of a character row: «N chats · when» / «No chats». */
function rowSummary(view: View, name: string): string {
  return textOf(characterRow(view, name).querySelector("span.leading-snug"));
}

/** Open a character's screen from the list (going back first if another character's screen is showing). */
function openCharacter(view: View, name: string): void {
  showCharacterList(view);
  fireEvent.click(characterRow(view, name));
}

const createControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="create_manual"]');
const importControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="import_char_short"]');
/** Screen-2 header: «+» new chat for this character. */
const newChatControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="new_chat"]');
/** Screen-2 header: the character's ⋮ menu. */
const characterMenuButton = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="sidebar_character_actions"]');
/** The hamburger — the first tap target of screen 1's header. */
const hamburger = (view: View) => inDrawer<HTMLElement>(view, "div.cursor-pointer");

function searchBox(view: View): HTMLInputElement {
  return view.getByPlaceholderText("search_name_placeholder") as HTMLInputElement;
}

/** A chat row (the panel's `.group` card) by title. */
function chatRowByTitle(view: View, title: string): HTMLElement {
  const row = [...drawer(view).querySelectorAll<HTMLElement>("div.group")].find((el) => el.querySelector("span.truncate")?.textContent === title);
  if (!row) throw new Error(`no chat row for "${title}"`);
  return row;
}

function chatRowTitles(view: View): string[] {
  return [...drawer(view).querySelectorAll<HTMLElement>("div.group")].map((row) => textOf(row.querySelector("span.truncate")));
}

/** The chat ⋮ button — the row's last button (a branch badge would precede it). */
function chatMenuButton(view: View, title: string): HTMLButtonElement {
  const buttons = chatRowByTitle(view, title).querySelectorAll<HTMLButtonElement>("button");
  const btn = buttons[buttons.length - 1];
  if (!btn) throw new Error(`no menu button on chat "${title}"`);
  return btn;
}

/** The inline rename input currently showing `value`. */
function renameInput(view: View, value: string): HTMLInputElement {
  const input = [...drawer(view).querySelectorAll<HTMLInputElement>("input")].find((i) => i.value === value);
  if (!input) throw new Error(`no rename input showing "${value}"`);
  return input;
}

beforeEach(() => {
  for (const spy of [switchChatSpy, createChatSpy, exportCharacterSpy, duplicateCharacterSpy, deleteCharacterSpy, openCharacterPicker, renameChatSpy]) spy.mockClear();
  resetModals();
  seedStores();
});

// ── Characterization: every action reachable before the drill-in stays reachable ──

describe("CoauthorRail drawer — the actions reachable before the drill-in", () => {
  it("create opens the create-character modal and closes the drawer", () => {
    const view = openRailOnList();
    expect(drawerIsOpen(view)).toBe(true);
    fireEvent.click(createControl(view));
    expect(useModalStore.getState().isCreateCharacterModalOpen).toBe(true);
    expect(drawerIsOpen(view)).toBe(false);
  });

  it("import opens the character file picker and closes the drawer", () => {
    const view = openRailOnList();
    fireEvent.click(importControl(view));
    expect(openCharacterPicker).toHaveBeenCalledTimes(1);
    expect(drawerIsOpen(view)).toBe(false);
  });

  it("lists every character, most recently active first (RP chats do not count in the Co-Author rail)", () => {
    const view = openRailOnList();
    expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
  });

  it("sort toggle switches the list to alphabetical", () => {
    const view = openRailOnList();
    fireEvent.click(view.getByLabelText("sort_toggle: sort_recent"));
    expect(useNavigationStore.getState().characterSortMode).toBe("alphabetical");
    expect(listedCharacters(view)).toEqual(["Aria", "Bram", "Cora"]);
  });

  it("search narrows the list by name; no match shows the empty text; clearing restores it", () => {
    const view = openRailOnList();
    fireEvent.change(searchBox(view), { target: { value: "ar" } });
    expect(listedCharacters(view)).toEqual(["Aria"]);
    fireEvent.change(searchBox(view), { target: { value: "zzz" } });
    expect(listedCharacters(view)).toEqual([]);
    expect(view.getByText("search_no_results")).toBeTruthy();
    fireEvent.change(searchBox(view), { target: { value: "" } });
    expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
  });

  it("tag filter: the sheet lists every tag, picking narrows the list (AND), the badge counts, reset restores", () => {
    const view = openRailOnList();
    fireEvent.click(view.getByLabelText("filter_by_tags"));
    expect(view.getByText("fantasy")).toBeTruthy();
    expect(view.getByText("scifi")).toBeTruthy();
    fireEvent.click(view.getByText("fantasy"));
    expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);
    fireEvent.click(view.getByText("scifi"));
    expect(listedCharacters(view)).toEqual(["Cora"]);
    const filterButton = view.getByLabelText("filter_by_tags");
    expect(textOf(filterButton.parentElement)).toContain("2");
    fireEvent.click(view.getByText("reset"));
    expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
  });

  it("the character menu lists the Co-Author items (export, duplicate, delete — no chat import) and export runs for that character", () => {
    const view = openRailOnList();
    openCharacter(view, "Bram");
    fireEvent.click(characterMenuButton(view));
    for (const label of ["sidebar_export", "duplicate", "delete"]) expect(view.getByText(label)).toBeTruthy();
    expect(view.queryByText("sidebar_import_chat")).toBeNull();

    fireEvent.click(view.getByText("sidebar_export"));
    expect(exportCharacterSpy).toHaveBeenCalledWith(BRAM);
  });

  it("character menu: duplicate runs for that character", () => {
    const view = openRailOnList();
    openCharacter(view, "Bram");
    fireEvent.click(characterMenuButton(view));
    fireEvent.click(view.getByText("duplicate"));
    expect(duplicateCharacterSpy).toHaveBeenCalledWith(BRAM);
  });

  it("character menu: delete asks for confirmation, and confirming deletes that character", () => {
    const view = openRailOnList();
    openCharacter(view, "Bram");
    fireEvent.click(characterMenuButton(view));
    fireEvent.click(view.getByText("delete"));
    const dialog = useCharacterStore.getState().confirmDestroy;
    expect(dialog?.title).toBe("sidebar_delete_character");
    dialog?.onConfirm();
    expect(deleteCharacterSpy).toHaveBeenCalledWith(BRAM);
  });

  it("new chat creates a Co-Author chat for the character it belongs to and leaves the drawer open", () => {
    const view = openRailOnList();
    openCharacter(view, "Bram");
    expect(useChatStore.getState().selectedCharacterId).toBe(BRAM);
    fireEvent.click(newChatControl(view));
    expect(createChatSpy).toHaveBeenCalledTimes(1);
    expect(createChatSpy).toHaveBeenCalledWith(BRAM, "coauthor");
    expect(drawerIsOpen(view)).toBe(true);
  });

  it("a character's chats are its Co-Author chats only; tapping one switches to it and leaves the drawer open", () => {
    const view = openRailOnList();
    openCharacter(view, "Aria");
    expect(chatRowTitles(view).sort()).toEqual(["Draft Outline", "Second Pass"]);
    fireEvent.click(chatRowByTitle(view, "Second Pass"));
    expect(switchChatSpy).toHaveBeenCalledWith(CHAT_A2);
    expect(drawerIsOpen(view)).toBe(true);
  });

  it("the chat menu offers rename and delete, and no JSONL export (Co-Author has no JSONL portability)", () => {
    const view = openRailOnList();
    openCharacter(view, "Aria");
    fireEvent.click(chatMenuButton(view, "Second Pass"));
    for (const label of ["sidebar_rename", "delete"]) expect(view.getByText(label)).toBeTruthy();
    expect(view.queryByText("sidebar_export_jsonl")).toBeNull();
  });

  it("the chat menu's delete asks for confirmation", () => {
    const view = openRailOnList();
    openCharacter(view, "Aria");
    fireEvent.click(chatMenuButton(view, "Second Pass"));
    fireEvent.click(view.getByText("delete"));
    expect(useCharacterStore.getState().confirmDestroy?.title).toBe("sidebar_delete_chat");
  });

  it("the tablet sheet (collapsed-strip avatar tap) lists the character's Co-Author chats; a chat switches, «+» creates a Co-Author chat", () => {
    seedStores();
    const view = render(createElement(CoauthorRail));
    const avatar = view.baseElement.querySelector<HTMLElement>('div[title="Aria"]');
    if (!avatar) throw new Error("no collapsed-strip avatar for Aria");
    fireEvent.click(avatar);
    const sheet = view.baseElement.querySelector<HTMLElement>(".bs-popup");
    if (!sheet) throw new Error("the tablet chats sheet is not mounted");
    const rows = [...sheet.querySelectorAll<HTMLElement>("div.group")];
    expect(rows.map((row) => textOf(row.querySelector("span.truncate"))).sort()).toEqual(["Draft Outline", "Second Pass"]);
    const second = rows.find((row) => textOf(row.querySelector("span.truncate")) === "Second Pass");
    if (!second) throw new Error("no chat row for Second Pass in the sheet");
    fireEvent.click(second);
    expect(switchChatSpy).toHaveBeenCalledWith(CHAT_A2);
    const newChat = sheet.querySelector<HTMLElement>('button[aria-label="new_chat"]');
    if (!newChat) throw new Error("no new-chat button in the sheet");
    fireEvent.click(newChat);
    expect(createChatSpy).toHaveBeenCalledWith(ARIA, "coauthor");
  });

  it("the Co-Author bottom panel keeps its four items", () => {
    const view = openRail();
    for (const label of ["coauthor.sidebar.modules", "coauthor.sidebar.skills", "provider_settings_tooltip", "interface_settings_tooltip"]) {
      expect(within(drawer(view)).getByText(label)).toBeTruthy();
    }
  });
});

// ── The drill-in ─────────────────────────────────────────────────────────

describe("CoauthorRail drawer — opens on the active chat's character", () => {
  it("with an active chat the drawer opens on that character's screen", () => {
    const view = openRail();
    expect(onCharacterScreen(view)).toBe(true);
    expect(screenTitle(view)).toBe("Aria");
    expect(chatRowTitles(view)).toEqual(["Draft Outline", "Second Pass"]);
  });

  it("opens on the ACTIVE CHAT's character, not the last selected one", () => {
    const view = openRail({ selectedCharacterId: BRAM });
    expect(screenTitle(view)).toBe("Aria");
  });

  it("the rule re-applies on every open: back, close, reopen lands on the active character again", () => {
    const view = openRail();
    fireEvent.click(backButton(view));
    expect(onCharacterScreen(view)).toBe(false);
    fireEvent.click(hamburger(view));
    expect(drawerIsOpen(view)).toBe(false);
    openDrawer();
    expect(drawerIsOpen(view)).toBe(true);
    expect(screenTitle(view)).toBe("Aria");
  });

  it("choosing an item of the character ⋮ sheet leaves the drawer mounted and open (the rail's portal host is the app-level node, not the sheet stack)", () => {
    const view = openRail();
    fireEvent.click(characterMenuButton(view));
    fireEvent.click(view.getByText("duplicate"));
    expect(duplicateCharacterSpy).toHaveBeenCalledWith(ARIA);
    expect(drawerIsOpen(view)).toBe(true);
    expect(screenTitle(view)).toBe("Aria");
  });

  it("rename from the chat menu commits on Enter", () => {
    const view = openRail();
    fireEvent.click(chatMenuButton(view, "Second Pass"));
    fireEvent.click(view.getByText("sidebar_rename"));
    fireEvent.change(renameInput(view, "Second Pass"), { target: { value: "Third Pass" } });
    fireEvent.keyDown(renameInput(view, "Third Pass"), { key: "Enter" });
    expect(renameChatSpy).toHaveBeenCalledWith(CHAT_A2, "Third Pass");
    expect(drawerIsOpen(view)).toBe(true);
  });
});

describe("CoauthorRail drawer — drilling in and out", () => {
  it("tapping a character opens its screen and selects it; the other characters' chats are not listed", () => {
    const view = openRailOnList();
    fireEvent.click(characterRow(view, "Bram"));
    expect(onCharacterScreen(view)).toBe(true);
    expect(screenTitle(view)).toBe("Bram");
    expect(useChatStore.getState().selectedCharacterId).toBe(BRAM);
    expect(chatRowTitles(view)).toEqual(["Station Notes"]);
  });

  it("back returns to the list with the search query, tag filter and sort kept", () => {
    const view = openRailOnList();
    fireEvent.click(view.getByLabelText("sort_toggle: sort_recent"));
    fireEvent.click(view.getByLabelText("filter_by_tags"));
    fireEvent.click(view.getByText("fantasy"));
    fireEvent.change(searchBox(view), { target: { value: "a" } });
    expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);

    fireEvent.click(characterRow(view, "Aria"));
    expect(screenTitle(view)).toBe("Aria");
    fireEvent.click(backButton(view));

    expect(screenTitle(view)).toBe("characters");
    expect(searchBox(view).value).toBe("a");
    expect(useNavigationStore.getState().characterSortMode).toBe("alphabetical");
    expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);
  });

  it("the query also survives closing and reopening the drawer", () => {
    const view = openRailOnList();
    fireEvent.change(searchBox(view), { target: { value: "br" } });
    fireEvent.click(hamburger(view));
    openDrawer();
    showCharacterList(view);
    expect(searchBox(view).value).toBe("br");
  });

  it("header «+» creates a Co-Author chat for THIS character; header ⋮ opens THIS character's menu", () => {
    const view = openRailOnList();
    openCharacter(view, "Cora");
    fireEvent.click(newChatControl(view));
    expect(createChatSpy).toHaveBeenCalledWith(CORA, "coauthor");

    fireEvent.click(characterMenuButton(view));
    fireEvent.click(view.getByText("sidebar_export"));
    expect(exportCharacterSpy).toHaveBeenCalledWith(CORA);
  });

  it("a character without Co-Author chats shows the panel's empty state; its «new chat» button creates a Co-Author chat", () => {
    const view = openRailOnList();
    openCharacter(view, "Cora");
    expect(chatRowTitles(view)).toEqual([]);
    expect(view.getByText("coauthor.list_empty")).toBeTruthy();
    fireEvent.click(inDrawer(view, "button.empty-cta"));
    expect(createChatSpy).toHaveBeenCalledWith(CORA, "coauthor");
  });

  it("a character that disappears while its screen is open falls back to the list", () => {
    const view = openRail();
    expect(screenTitle(view)).toBe("Aria");
    act(() => {
      const current = useBootstrapStore.getState().data;
      if (!current) throw new Error("bootstrap data was not seeded");
      useBootstrapStore.setState({ data: { ...current, allCharacters: CHARACTERS.filter((c) => c.id !== ARIA) } });
    });
    expect(screenTitle(view)).toBe("characters");
    expect(listedCharacters(view)).toEqual(["Bram", "Cora"]);
  });

  it("both screens carry a Drawer.Title as the dialog's accessible name", () => {
    const view = openRail();
    const dialog = view.baseElement.querySelector('[role="dialog"]');
    const nameOf = () => {
      const id = dialog?.getAttribute("aria-labelledby");
      return textOf(id ? view.baseElement.querySelector(`#${CSS.escape(id)}`) : null);
    };
    expect(nameOf()).toBe("Aria");
    fireEvent.click(backButton(view));
    expect(nameOf()).toBe("characters");
  });
});

// ── The Co-Author mode bucket and the chat-list source ───────────────────

describe("CoauthorRail drawer — the Co-Author mode bucket", () => {
  it("a character with both an RP and a Co-Author chat shows «1» on screen 1 and only the Co-Author chat on screen 2", () => {
    const view = openRailOnList();
    expect(rowSummary(view, "Bram")).toBe(`chat_count#1 · ${formatRelativeTime(chatRows().find((c) => c.id === CHAT_B1)!.updatedAt)}`);
    fireEvent.click(characterRow(view, "Bram"));
    expect(chatRowTitles(view)).toEqual(["Station Notes"]);
  });

  it("counts every Co-Author chat of a character; a character with only an RP chat says it has none", () => {
    const view = openRailOnList();
    expect(rowSummary(view, "Aria")).toBe(`chat_count#2 · ${formatRelativeTime(chatRows().find((c) => c.id === CHAT_A1)!.updatedAt)}`);
    expect(rowSummary(view, "Cora")).toBe("rail_no_chats");
  });

  it("the count equals the rows its screen lists, for every character", () => {
    const view = openRailOnList();
    for (const name of CHARACTER_NAMES) {
      showCharacterList(view);
      const summary = rowSummary(view, name);
      fireEvent.click(characterRow(view, name));
      const rows = chatRowTitles(view).length;
      if (rows === 0) expect(summary).toBe("rail_no_chats");
      else expect(summary).toStartWith(`chat_count#${rows}`);
    }
  });

  it("the chat list is the sidebar list, not the chat meta: counts and rows survive an unloaded snapshot character", () => {
    const view = openRailOnList({ snapshotCharacter: false });
    expect(rowSummary(view, "Aria")).toStartWith("chat_count#2");
    fireEvent.click(characterRow(view, "Aria"));
    expect(chatRowTitles(view)).toEqual(["Draft Outline", "Second Pass"]);
  });
});

describe("CoauthorRail drawer — no branch UI", () => {
  const BRANCH_TEXTS = ["sidebar_timeline_branches", "sidebar_fork_short", "sidebar_delete_branch_short", "Side thread"];

  it("neither screen shows branches although the active chat's snapshot carries them", () => {
    const view = openRail();
    expect(onCharacterScreen(view)).toBe(true);
    for (const text of BRANCH_TEXTS) expect(within(drawer(view)).queryByText(text)).toBeNull();
    expect(drawer(view).querySelector('button[aria-label="sidebar_chat_branches"]')).toBeNull();
    expect(drawer(view).querySelector("div.border-dashed")).toBeNull();

    fireEvent.click(backButton(view));
    for (const text of BRANCH_TEXTS) expect(within(drawer(view)).queryByText(text)).toBeNull();
    expect(drawer(view).querySelector('button[aria-label="sidebar_chat_branches"]')).toBeNull();
  });
});
