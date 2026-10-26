/**
 * Rail bottom panel — the «Persona» launcher (MOBILE_COMPOSER_POLISH CM-3).
 *
 * The play-mode drawer's quick actions gain a persona row as their FIRST row,
 * mirroring the desktop sidebar footer's persona item: the active persona's
 * avatar (initials without one) and name (or `no_persona`), a tap opens the
 * persona modal and closes the drawer. The name/avatar derivation is the shared
 * `useActivePersonaDisplay` hook (the desktop footer reads the same one).
 *
 * Renders the real `<Rail />` with real stores; only the boundaries are doubled,
 * as in `rail-chat-list-hosts.test` (`useT` keys verbatim, tooltip provider, the
 * two controllers, the two mobile import orchestrators).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { forwardRef, type ReactNode } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppCharacter, AppSnapshot, PersonaRecord } from "../../../api/types.js";
import type { CharacterImportMobileHandle } from "../../modals/import/CharacterImportMobile.js";
import type { ChatImportMobileHandle } from "../../modals/import/ChatImportMobile.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";

useDomEnv({ failOnNetwork: true });

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");

// ── Doubles ──────────────────────────────────────────────────────────────

installI18nContextSeam({
	custom: {
		t: (key, opts?) => (typeof opts?.count === "number" ? `${key}#${opts.count}` : key),
		tDynamic: (key) => key,
	},
});

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const NOOP_ASYNC = async () => {};
const CHAT_STUB = {
	handleSwitchChat: mock(async (_chatId: ChatId): Promise<void> => {}),
	handleFork: NOOP_ASYNC,
	handleDeleteActiveBranch: NOOP_ASYNC,
};
const CHARACTER_STUB = {
	handleCreateChat: NOOP_ASYNC,
	handleExportCharacter: NOOP_ASYNC,
	handleDuplicateCharacter: NOOP_ASYNC,
	handleDeleteCharacter: NOOP_ASYNC,
	handleExportChatJsonl: NOOP_ASYNC,
	handleRemoveChat: NOOP_ASYNC,
	handleRenameChat: NOOP_ASYNC,
	handleImportFiles: NOOP_ASYNC,
	getChatRemovalMode: () => "delete" as const,
	isImporting: false,
};

const realChatController = await import("../../../hooks/use-chat-controller.js");
mock.module("../../../hooks/use-chat-controller.js", () => ({
	...realChatController,
	useChatController: () => CHAT_STUB,
}));
const realCharacterController = await import("../../../hooks/use-character-controller.js");
mock.module("../../../hooks/use-character-controller.js", () => ({
	...realCharacterController,
	useCharacterController: () => CHARACTER_STUB,
}));

// The orchestrators are always-mounted children the rail drives through a ref;
// these doubles render nothing (the tests never open a picker).
const realCharacterImport = await import("../../modals/import/CharacterImportMobile.js");
mock.module("../../modals/import/CharacterImportMobile.js", () => ({
	...realCharacterImport,
	CharacterImportMobile: forwardRef<CharacterImportMobileHandle, object>(function CharacterImportDouble() {
		return null;
	}),
}));
const realChatImport = await import("../../modals/import/ChatImportMobile.js");
mock.module("../../modals/import/ChatImportMobile.js", () => ({
	...realChatImport,
	ChatImportMobile: forwardRef<ChatImportMobileHandle, object>(function ChatImportDouble() {
		return null;
	}),
}));

const { Rail } = await import("../Rail.js");
const { useBootstrapStore } = await import("../../../stores/api-actions/bootstrap-actions.js");
const { useChatStore, useModalStore, useNavigationStore } = await import("../../../stores/index.js");
const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");


// ── Fixtures ─────────────────────────────────────────────────────────────

function makePersona(id: string, name: string, over: Partial<PersonaRecord> = {}): PersonaRecord {
	return {
		id,
		name,
		description: "",
		pronouns: null,
		pronounForms: null,
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		defaultForNewChats: false,
		avatarDescription: null,
		includeAvatarInPrompt: false,
		updatedAt: "2026-10-01T00:00:00.000Z",
		...over,
	};
}

function seed(personas: PersonaRecord[] | null): void {
	useNavigationStore.setState({ mode: "play", characterSortMode: "recent", chatSortMode: "recent", railForceOpen: 0 });
	useBootstrapStore.setState({
		personas,
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: [],
			uiSettings: wireUiSettings(),
			agentKindSettings: {},
			isArmServer: false,
		},
	});
	useChatStore.setState({ activeChatId: null, selectedCharacterId: null });
	useModalStore.setState({ isPersonaModalOpen: false });
	useSnapshotStore.setState({ character: null, persona: null, activeChat: null, activeBranch: null, branches: [], chatIds: [], chatsById: {} });
}

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Render the rail and open its drawer the way the TopBar hamburger does. */
function openRail(): View {
	const view = render(<Rail />);
	act(() => {
		useNavigationStore.setState({ railForceOpen: useNavigationStore.getState().railForceOpen + 1 });
	});
	return view;
}

/** The bottom panel's rows, in order (the panel is the drawer popup's last child). */
function panelRows(view: View): HTMLElement[] {
	const panel = view.baseElement.querySelector<HTMLElement>(".rail-popup")?.lastElementChild;
	if (!panel) throw new Error("the rail bottom panel is not mounted");
	return [...panel.children] as HTMLElement[];
}

const labelOf = (row: HTMLElement) => row.querySelector("span.truncate")?.textContent ?? "";

// ── Tests ────────────────────────────────────────────────────────────────

describe("Rail bottom panel — persona row", () => {
	it("is the FIRST row; the four existing rows follow in their old order", () => {
		seed([makePersona("p1", "Mira Vale", { defaultForNewChats: true })]);
		const rows = panelRows(openRail());
		expect(rows.map(labelOf)).toEqual(["Mira Vale", "prompt_manager", "scenario_memory", "provider_settings_tooltip", "interface_settings_tooltip"]);
	});

	it("shows the default persona's name and its initials without an avatar", () => {
		seed([makePersona("p1", "Alpha Beta"), makePersona("p2", "Mira Vale", { defaultForNewChats: true })]);
		const row = panelRows(openRail())[0];
		expect(labelOf(row)).toBe("Mira Vale");
		expect(row.querySelector("img")).toBeNull();
		expect(row.querySelector("span.rounded-full")?.textContent).toBe("MV");
	});

	it("falls back to the first persona when none is the default", () => {
		seed([makePersona("p1", "Alpha Beta"), makePersona("p2", "Mira Vale")]);
		expect(labelOf(panelRows(openRail())[0])).toBe("Alpha Beta");
	});

	it("renders the persona's avatar image when it has one", () => {
		seed([makePersona("p1", "Mira Vale", { defaultForNewChats: true, avatarExt: "png", avatarAssetId: "asset-1" })]);
		const row = panelRows(openRail())[0];
		const img = row.querySelector("img");
		expect(img?.getAttribute("src")).toContain("/api/personas/p1/avatar");
		expect(row.querySelector("span.rounded-full")?.textContent).toBe("");
	});

	it("shows the no_persona label (and its initials) when there is no persona", () => {
		seed([]);
		const row = panelRows(openRail())[0];
		expect(labelOf(row)).toBe("no_persona");
		expect(row.querySelector("img")).toBeNull();
	});

	it("the active chat's persona wins over the bootstrap default", () => {
		seed([makePersona("p1", "Mira Vale", { defaultForNewChats: true })]);
		const chatPersona = makePersona("p9", "Chat Persona");
		act(() => {
			useSnapshotStore.setState({
				character: { id: "c1", name: "Aria" } as unknown as AppCharacter,
				persona: chatPersona,
				activeChat: { id: "ch1", characterId: "c1" } as unknown as NonNullable<AppSnapshot["activeChat"]>,
			});
		});
		expect(labelOf(panelRows(openRail())[0])).toBe("Chat Persona");
	});

	it("keeps the neighbors' row height and ellipsizes a long name", () => {
		seed([makePersona("p1", "A very long persona name that would never fit the drawer's bottom panel", { defaultForNewChats: true })]);
		const rows = panelRows(openRail());
		const [persona, neighbor] = rows;
		expect(persona.classList.contains("h-9")).toBe(true);
		expect(persona.className).toBe(neighbor.className);
		const label = persona.querySelector("span.truncate");
		expect(label?.classList.contains("min-w-0")).toBe(true);
	});

	it("a tap opens the persona modal and closes the drawer", async () => {
		seed([makePersona("p1", "Mira Vale", { defaultForNewChats: true })]);
		const view = openRail();
		expect(view.baseElement.querySelector(".rail-popup")).not.toBeNull();
		fireEvent.click(panelRows(view)[0]);
		expect(useModalStore.getState().isPersonaModalOpen).toBe(true);
		await waitFor(() => expect(view.baseElement.querySelector(".rail-popup")).toBeNull());
	});
});
