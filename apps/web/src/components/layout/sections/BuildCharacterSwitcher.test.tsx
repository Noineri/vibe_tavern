/**
 * BuildCharacterSwitcher tests (LB-3A).
 *
 * Two layers:
 *
 * 1. CHARACTERIZATION (renders the real <Sidebar />, both build-mode
 *    switchers — expanded row trigger and collapsed avatar flyout). Written
 *    BEFORE the BuildCharacterSwitcher extraction and kept UNCHANGED after
 *    it: the extraction must be behavior-preserving, so these keep guarding
 *    the Sidebar integration through the new component. The Radix popover
 *    content DOES mount in happy-dom via the pointerDown+click idiom
 *    (documented in LinkBindingPopover.test.tsx / ImageGen openChip).
 *
 * 2. UNIT (renders <BuildCharacterSwitcher /> with direct props): the pinned
 *    search row (> MAX_VISIBLE_ITEMS tabs), case-insensitive filtering with
 *    preserved order, the no-results line, query reset on close, and lazy
 *    row images — per variant.
 *
 * Cyrillic names are written via \u escapes — the code repo is Cyrillic-free
 * and the commit guard blocks literal Cyrillic in staged lines.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from "bun:test";
import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });

// RTL must load AFTER the DOM registration (dom-env contract): a static
// import binds react-dom's module-scope environment before `document`
// exists, which breaks React's input/change delegation into portals —
// clicks still worked, typing silently didn't (found via zz-probe bisect,
// LB-3A).
const { render, fireEvent, act, waitFor, within } = await import("@testing-library/react");

// --- House mocks (RichChatRow.test.tsx pattern) -------------------------
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realChatController = await import("../../../hooks/use-chat-controller.js");
const realCharacterController = await import("../../../hooks/use-character-controller.js");

const switchChatSpy = mock(async () => {});
const createChatSpy = mock(async () => {});

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("../../../hooks/use-chat-controller.js", () => ({
	...realChatController,
	useChatController: () => CHAT_STUB,
}));

mock.module("../../../hooks/use-character-controller.js", () => ({
	...realCharacterController,
	useCharacterController: () => CHARACTER_STUB,
}));

import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useNavigationStore } from "../../../stores/index.js";
import { wireCharacter } from "../../../../test/wire-fixtures.js";
import {
	brandId,
	normalizeAutoSummaryConfig,
	normalizeInsightsConfig,
	normalizeObjectiveState,
	type ChatBranchId,
	type ChatId,
	type CharacterId,
} from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../../api/types.js";

import type { CharacterTab } from "../app-shell-types.js";
import type { TFn } from "./section-types.js";

const { Sidebar } = await import("../Sidebar.js");
const { BuildCharacterSwitcher } = await import("./BuildCharacterSwitcher.js");

const tStub: TFn = (key) => key;

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

const CHAT_STUB = {
	handleSend: NOOP_ASYNC,
	handleCancelGeneration: NOOP,
	handleSwitchChat: switchChatSpy,
	handleStartEdit: NOOP,
	handleCancelEdit: NOOP,
	handleSaveMessageEdit: NOOP_ASYNC,
	handleDeleteMessage: NOOP_ASYNC,
	handleDeleteVariant: NOOP_ASYNC,
	handleRegenerateMessage: NOOP_ASYNC,
	handleContinueMessage: NOOP_ASYNC,
	handleSelectMessageVariant: NOOP_ASYNC,
	handleResend: NOOP_ASYNC,
	handleFork: NOOP_ASYNC,
	handleActivateBranch: NOOP_ASYNC,
	handleDeleteActiveBranch: NOOP_ASYNC,
	handleRenameBranch: NOOP_ASYNC,
	runRegenerateJob: NOOP_ASYNC,
};

const CHARACTER_STUB = {
	handleSaveCharacter: NOOP_ASYNC,
	handleAvatarUpload: NOOP_ASYNC,
	handleSavePersona: NOOP_ASYNC,
	handleSetChatPersona: NOOP_ASYNC,
	handleCreatePersona: NOOP_ASYNC,
	handleDeletePersona: NOOP_ASYNC,
	handleDuplicatePersona: NOOP_ASYNC,
	handleSetDefaultPersona: NOOP_ASYNC,
	handleImportFiles: NOOP_ASYNC,
	handleImportDragOver: NOOP,
	handleImportDragLeave: NOOP,
	handleImportDrop: NOOP,
	handleImportInputChange: NOOP,
	handleArchiveCharacter: NOOP_ASYNC,
	handleUnarchiveCharacter: NOOP_ASYNC,
	handleDeleteCharacter: NOOP_ASYNC,
	handleDuplicateCharacter: NOOP_ASYNC,
	getChatRemovalMode: () => "none" as const,
	handleRemoveChat: NOOP_ASYNC,
	handleDeleteChat: NOOP_ASYNC,
	handleClearChat: NOOP_ASYNC,
	handleRenameChat: NOOP_ASYNC,
	handleCreateChat: createChatSpy,
	handleCreateCharacter: NOOP_ASYNC,
	handleExportCharacter: NOOP_ASYNC,
	handleExportPng: NOOP_ASYNC,
	handleExportVtf: NOOP_ASYNC,
	handleExportChatJsonl: NOOP_ASYNC,
	handleExportPromptTrace: NOOP_ASYNC,
	isSavingCharacter: false,
	isImporting: false,
};

// --- Fixtures ------------------------------------------------------------

function makeEntry(id: string, name: string): AppCharacterEntry {
	return {
		id,
		name,
		subtitle: "",
		tags: [],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

function makeChat(id: string, characterId: string): ChatListItem {
	return {
		id: brandId<ChatId>(id),
		title: id,
		characterId: brandId<CharacterId>(characterId),
		characterName: "",
		subtitle: "",
		activeBranchLabel: "",
		mode: "rp",
		messageCount: 0,
		lastMessageAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

/** Seed stores for one rendered Sidebar. Two characters; "Bree" (c2) has a
 *  chat, "Alpha" (c1) does not — the pick paths differ by design. */
function seedSidebar(collapsed: boolean): void {
	useNavigationStore.setState({ mode: "build", sidebarCollapsed: collapsed });
	useSnapshotStore.setState({
		character: wireCharacter(),
		persona: null,
		allCharacters: [makeEntry("c1", "Alpha"), makeEntry("c2", "Bree")],
		chatIds: [brandId<ChatId>("chat-b")],
		chatsById: { "chat-b": makeChat("chat-b", "c2") },
		activeChat: {
			id: brandId<ChatId>("chat-b"),
			characterId: brandId<CharacterId>("c2"),
			personaId: null,
			title: "chat-b",
			status: "active",
			mode: "rp",
			activeBranchId: brandId<ChatBranchId>("br-0"),
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
		branches: [],
	});
}

/** The Radix popover trigger (aria-haspopup) — unique per switcher render. */
function switcherTrigger(container: HTMLElement): HTMLElement {
	const el = container.querySelector('[aria-haspopup="dialog"]');
	if (!(el instanceof HTMLElement)) throw new Error("switcher trigger not found");
	return el;
}

function openTrigger(trigger: HTMLElement): void {
	act(() => {
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
	});
}

// ── Characterization: the real Sidebar, both variants ───────────────────

describe("Sidebar build-mode character switcher — characterization (LB-3A)", () => {
	beforeEach(() => {
		switchChatSpy.mockClear();
		createChatSpy.mockClear();
	});

	it("expanded: lists every character tab", async () => {
		seedSidebar(false);
		const { container } = render(<Sidebar />);
		openTrigger(switcherTrigger(container));
		await waitFor(() => expect(within(document.body).getByText("Alpha")).toBeTruthy());
		expect(within(document.body).getByText("Bree")).toBeTruthy();
	});

	it("expanded: picking a tab with a chat switches to it and closes", async () => {
		seedSidebar(false);
		const { container } = render(<Sidebar />);
		const trigger = switcherTrigger(container);
		openTrigger(trigger);
		await act(async () => {
			fireEvent.click(within(document.body).getByText("Bree"));
		});
		expect(switchChatSpy).toHaveBeenCalledTimes(1);
		expect(switchChatSpy).toHaveBeenCalledWith(brandId<ChatId>("chat-b"));
		expect(createChatSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
	});

	it("expanded: picking a tab without a chat creates one", async () => {
		seedSidebar(false);
		const { container } = render(<Sidebar />);
		openTrigger(switcherTrigger(container));
		await act(async () => {
			fireEvent.click(within(document.body).getByText("Alpha"));
		});
		expect(createChatSpy).toHaveBeenCalledTimes(1);
		expect(createChatSpy).toHaveBeenCalledWith("c1");
		expect(switchChatSpy).not.toHaveBeenCalled();
	});

	it("collapsed: lists every tab in the avatar flyout", () => {
		seedSidebar(true);
		const { container } = render(<Sidebar />);
		openTrigger(switcherTrigger(container));
		expect(within(document.body).getByText("Alpha")).toBeTruthy();
		expect(within(document.body).getByText("Bree")).toBeTruthy();
	});

	it("collapsed: picking a tab switches and closes", async () => {
		seedSidebar(true);
		const { container } = render(<Sidebar />);
		const trigger = switcherTrigger(container);
		openTrigger(trigger);
		await act(async () => {
			fireEvent.click(within(document.body).getByText("Bree"));
		});
		expect(switchChatSpy).toHaveBeenCalledTimes(1);
		expect(switchChatSpy).toHaveBeenCalledWith(brandId<ChatId>("chat-b"));
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
	});
});

// ── Unit: BuildCharacterSwitcher with direct props ────────────────────

function makeTab(id: string, name: string, over: Partial<CharacterTab> = {}): CharacterTab {
	return {
		id,
		name,
		subtitle: "",
		chatId: null,
		avatarAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		updatedAt: "2026-10-01T00:00:00.000Z",
		...over,
	};
}

function makeTabs(names: string[]): CharacterTab[] {
	return names.map((name, i) => makeTab(`c${i + 1}`, name));
}

/** Mirrors Sidebar's wiring: onPick records the tab and closes (open is
 *  controlled here, exactly like charSwitcherOpen in Sidebar). `forceOpen`
 *  lets a rerender drive the open state through real effects (useState does
 *  NOT re-seed on rerender). */
let picked: CharacterTab | null = null;
function MockSwitcher(props: { variant: "expanded" | "collapsed"; tabs: CharacterTab[]; forceOpen?: boolean }) {
	const [open, setOpenInternal] = useState(true);
	useEffect(() => {
		if (props.forceOpen !== undefined) setOpenInternal(props.forceOpen);
	}, [props.forceOpen]);
	return (
		<BuildCharacterSwitcher
			variant={props.variant}
			open={open}
			onOpenChange={setOpenInternal}
			characterTabs={props.tabs}
			activeCharacterId={null}
			activeCharacterName={null}
			activeAvatarSrc={null}
			onPick={(tab) => { picked = tab; setOpenInternal(false); }}
			t={tStub}
		/>
	);
}

const searchInput = (): HTMLInputElement | null =>
	document.body.querySelector('input[aria-label="link_binding_search_placeholder"]');

function typeQuery(value: string): void {
	const input = searchInput();
	if (!(input instanceof HTMLInputElement)) throw new Error("search input not found");
	act(() => {
		fireEvent.change(input, { target: { value } });
	});
}

const VARIANTS = ["expanded", "collapsed"] as const;

describe("BuildCharacterSwitcher — unit (LB-3A)", () => {
	beforeEach(() => { picked = null; });

	for (const variant of VARIANTS) {
		it(`${variant}: lists every tab when open`, () => {
			render(<MockSwitcher variant={variant} tabs={makeTabs(["Alpha", "Bree", "Cory"])} />);
			expect(within(document.body).getByText("Alpha")).toBeTruthy();
			expect(within(document.body).getByText("Bree")).toBeTruthy();
			expect(within(document.body).getByText("Cory")).toBeTruthy();
		});

		it(`${variant}: picking a tab fires onPick and closes`, async () => {
			render(<MockSwitcher variant={variant} tabs={makeTabs(["Alpha", "Bree"])} />);
			await act(async () => {
				fireEvent.click(within(document.body).getByText("Bree"));
			});
			expect(picked?.name).toBe("Bree");
			await waitFor(() => expect(within(document.body).queryByText("Bree")).toBeNull());
		});

		it(`${variant}: no search row with 6 tabs, present with 7`, () => {
			const six = makeTabs(["A", "B", "C", "D", "E", "F"]);
			const { unmount } = render(<MockSwitcher variant={variant} tabs={six} />);
			expect(searchInput()).toBeNull();
			unmount();

			const seven = [...six, makeTab("c7", "G")];
			render(<MockSwitcher variant={variant} tabs={seven} />);
			expect(searchInput() instanceof HTMLInputElement).toBe(true);
		});

		it(`${variant}: typing filters case-insensitively, order preserved, Cyrillic matches`, () => {
			const tabs = makeTabs(["Alpha", "bree", "\u0410\u043d\u043d\u0430", "Cory", "Dana", "Eli", "Finn"]);
			render(<MockSwitcher variant={variant} tabs={tabs} />);
			typeQuery("BREE");
			expect(within(document.body).queryByText("Alpha")).toBeNull();
			expect(within(document.body).getByText("bree")).toBeTruthy();
			expect(within(document.body).queryByText("Cory")).toBeNull();
			typeQuery("\u0410\u041d"); // upper-case Cyrillic query matches the mixed-case name
			expect(within(document.body).getByText("\u0410\u043d\u043d\u0430")).toBeTruthy();
			expect(within(document.body).queryByText("Alpha")).toBeNull();
		});

		it(`${variant}: no-results line when nothing matches`, () => {
			render(<MockSwitcher variant={variant} tabs={makeTabs(["Alpha", "Bree", "Cory", "D", "E", "F", "G"])} />);
			typeQuery("zzz");
			expect(within(document.body).getByText("link_binding_no_results")).toBeTruthy();
			expect(within(document.body).queryByText("Alpha")).toBeNull();
		});

		it(`${variant}: query resets after close and reopen`, async () => {
			const tabs = makeTabs(["Alpha", "Bree", "Cory", "D", "E", "F", "G"]);
			const { rerender } = render(
				<MockSwitcher variant={variant} tabs={tabs} />,
			);
			typeQuery("Bree");
			expect(within(document.body).queryByText("Alpha")).toBeNull();
			// Close (parent flips open), reopen — query must be empty again.
			rerender(<MockSwitcher variant={variant} tabs={tabs} forceOpen={false} />);
			await waitFor(() => expect(within(document.body).queryByText("Bree")).toBeNull());
			rerender(<MockSwitcher variant={variant} tabs={tabs} forceOpen={true} />);
			const input = searchInput();
			expect(input instanceof HTMLInputElement).toBe(true);
			expect((input as HTMLInputElement).value).toBe("");
			expect(within(document.body).getByText("Alpha")).toBeTruthy();
		});

		it(`${variant}: row images are lazy-decoded`, () => {
			const withAvatar = [makeTab("c1", "Alpha", { avatarExt: "png", avatarAssetId: "a1" })];
			const tabs = [...withAvatar, ...makeTabs(["Bree", "Cory"]).slice(0, 1)];
			render(<MockSwitcher variant={variant} tabs={tabs} />);
			const img = within(document.body).getAllByRole("img")[0];
			expect(img.getAttribute("loading")).toBe("lazy");
			expect(img.getAttribute("decoding")).toBe("async");
		});
	}
});
