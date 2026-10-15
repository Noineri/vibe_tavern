/**
 * CA-10 — CoauthorCharacterForm (live co-author MD editor).
 *
 * Pins the Wave-4 live co-authoring behaviours:
 *  - renders the active character's MD body (prose headings + content; no
 *    frontmatter name) — the document the user and AI co-author;
 *  - idle: the editor is EDITABLE (contentEditable !== "false") and the header
 *    shows the saved/dirty subtitle;
 *  - generating (isSending): the editor is LOCKED (contentEditable === "false"
 *    via the EditorView.editable compartment) and the "AI is editing…"
 *    affordance shows — the turn-taking concurrency control;
 *  - falls back to the placeholder when there is no active character.
 *
 * Uses the real snapshot store to avoid a process-global mock.module leak.
 * Module-held editor maps and Zustand stores are restored after the suite;
 * per-case cleanup prevents state from crossing assertions. `useIsSending` is
 * overridden via the spread-real pattern (no other test file consumes it, so
 * zero leak). CM6 mounting in happy-dom is graceful-skip (mirrors
 * VibeMdView.test.tsx); the header affordance text is the always-present
 * primary assertion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { wireCharacter } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
import type { AppCharacter, LorebookRecord } from "../../api/types.js";
import type { BootstrapData } from "../../stores/api-actions/bootstrap-actions.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import { coauthorApplySchema, coauthorToolOutputSchema, sendMessageSchema } from "@vibe-tavern/api-contracts";
import { normalizeTrackerTemplate } from "@vibe-tavern/domain";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { EditorView } from "@codemirror/view";
import { sendChatMessage } from "../../api/chat-api.js";
import { sendStream } from "../../api/stream.js";
import {
	clearCoauthorEditorSnapshotStateForTests,
	readCoauthorEditorState,
	restoreCoauthorEditorSnapshotStateForTests,
	snapshotCoauthorEditorSnapshotStateForTests,
} from "../../lib/coauthor-editor-snapshot.js";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
const handleSaveCharacter = mock(async () => undefined);
const realI18nContext = await import("../../i18n/context.js");
const realCharacterController = await import("../../hooks/use-character-controller.js");
const realTooltip = await import("../shared/Tooltip.js");
const realLorebookApi = await import("../../api/lorebook-api.js");
const realPersonaApi = await import("../../api/persona-api.js");
const realScriptApi = await import("../../api/script-api.js");
const realCharacterApi = await import("../../api/character-api.js");
const realRegexApi = await import("../../api/regex-api.js");
const realChatStore = await import("../../stores/chat-store.js");
const realCharacterTrackerTemplate = await import("../../hooks/use-character-tracker-template.js");
const listAllLorebooksMock = mock((): Promise<LorebookRecord[]> => Promise.resolve([]));
const listCharacterLorebooksMock = mock((): Promise<LorebookRecord[]> => Promise.resolve([]));
const refetchTrackerTemplateMock = mock(async () => undefined);

/** Shared Checkbox exposes its state via aria-checked (role="checkbox"), not input.checked. */
const ariaChecked = (el: Element) => el.getAttribute("aria-checked") === "true";
type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// useCharacterController is not consumed by any other test file → safe to mock
// fully. Stub the save write-path so the test never hits the network.
// Keep the binding above the later mock.module registration.
mock.module("../../hooks/use-character-controller.js", () => ({
	...realCharacterController,
	useCharacterController: () => ({ handleSaveCharacter, isSavingCharacter: false }),
}));

// CA-13: the lorebook picker (LinkBindingPopover) pulls in CustomTooltip,
// which needs a Radix TooltipProvider context irrelevant to the form's
// behaviours. Passthrough it, mirroring VibeMdView.test.tsx.
mock.module("../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
	TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// The picker fetches the lorebook / persona / script lists on mount (CE-C1),
// and BoundResourcesField reads + writes character bindings (CE-C2/C3); stub
// them empty/no-op so the form renders without hitting the network. Reals are
// spread first so every other export stays intact.
mock.module("../../api/lorebook-api.js", () => ({
	...realLorebookApi,
	listAllLorebooks: listAllLorebooksMock,
	getLorebookLinks: () => Promise.resolve([]),
	setLorebookLinks: () => Promise.resolve([]),
}));
mock.module("../../api/character-api.js", () => ({
	...realCharacterApi,
	listCharacterLorebooks: listCharacterLorebooksMock,
	listCharacterScripts: () => Promise.resolve([]),
}));
mock.module("../../hooks/use-character-tracker-template.js", () => ({
	...realCharacterTrackerTemplate,
	useCharacterTrackerTemplate: () => ({
		template: null,
		loading: false,
		error: null,
		save: mock(),
		clear: mock(),
		refetch: refetchTrackerTemplateMock,
	}),
}));
mock.module("../../api/persona-api.js", () => ({
	...realPersonaApi,
	listPersonas: () => Promise.resolve([]),
	listPersonaLorebooks: () => Promise.resolve([]),
	listPersonaScripts: () => Promise.resolve([]),
}));
mock.module("../../api/script-api.js", () => ({
	...realScriptApi,
	listAllScripts: () => Promise.resolve([]),
	getScriptLinks: () => Promise.resolve([]),
	setScriptLinks: () => Promise.resolve([]),
}));
mock.module("../../api/regex-api.js", () => ({
	...realRegexApi,
	// RX-12: regex binding functions — same empty/no-op treatment so the
	// field's regex group renders without the network.
	listAllRegexPresets: () => Promise.resolve([]),
	getRegexLinks: () => Promise.resolve([]),
	setRegexLinks: () => Promise.resolve([]),
}));

// chat-store: spread the REAL module first (preserves every other export for
// any co-running test file), override ONLY useIsSending with a controllable
// value.
// `__isSending` is a plain `let` declared above the (lexically lower) mock so
// its closure binding is initialized by the time the lazily-invoked factory
// runs; tests mutate it directly and the `useIsSending` closure reads the
// live value on every render.
let __isSending = false;
mock.module("../../stores/chat-store.js", () => ({
		...realChatStore,
		useIsSending: () => __isSending,
}));

let CoauthorCharacterForm: typeof import("./CoauthorCharacterForm.js").CoauthorCharacterForm;
beforeAll(async () => {
	({ CoauthorCharacterForm } = await import("./CoauthorCharacterForm.js"));
});

function setLoreModel(modelName: string | null) {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: [],
			uiSettings: {
				id: "default", theme: "dark", chatFontSize: 15, uiFontSize: 14, messageWidth: 700, language: "en",
				activePromptPresetId: null, aiAssistantProviderId: null, aiAssistantModelName: null,
				coauthorProviderId: null, coauthorLoreProviderId: modelName ? "profile_1" : null, coauthorLoreModelName: modelName, updatedAt: "2026-01-01",
			},
			isArmServer: false,
		} as unknown as BootstrapData,
	});
}

function makeCharacter(over: Partial<AppCharacter> = {}): AppCharacter {
	return {
		...wireCharacter(),
		id: "char_test",
		name: "Kira",
		description: "A reserved arachnid weaver.",
		scenario: "A forest cave.",
		systemPrompt: "",
		subtitle: "",
		firstMessage: "Welcome to my web, little fly.",
		mesExample: "{{char}}: *tilts head*",
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
		avatarExt: null,
		avatarFullExt: null,
		personalitySummary: null,
		includeGalleryInPrompt: false,
		includeAvatarInPrompt: false,
		avatarDescription: null,
		updatedAt: "2026-06-30T00:00:00Z",
		...over,
	};
}

/** Read the CM content element's contentEditable state, or null if CM didn't mount. */
function cmEditable(container: HTMLElement): string | null {
	const cm = container.querySelector(".cm-content") as HTMLElement | null;
	if (!cm) return null;
	return cm.getAttribute("contenteditable");
}

describe("CoauthorCharacterForm", () => {

	/** Original fetch — restored in afterEach so the globalThis.fetch mock (Apply) never leaks cross-file. */
	const realFetch = globalThis.fetch;
	/** Original toast.warning — spied by mutation (no mock.module → no sonner collision). */
	const realToastWarning = toast.warning;
	const originalSnapshotState = snapshotCoauthorEditorSnapshotStateForTests();
	const originalAppSnapshotState = useSnapshotStore.getState();
	const originalBootstrapState = useBootstrapStore.getState();
	const originalTurnState = useCoauthorTurnStore.getState();

	beforeEach(() => {
		clearCoauthorEditorSnapshotStateForTests();
		globalThis.fetch = realFetch;
		toast.warning = realToastWarning;
		listAllLorebooksMock.mockReset();
		listAllLorebooksMock.mockResolvedValue([]);
		listCharacterLorebooksMock.mockReset();
		listCharacterLorebooksMock.mockResolvedValue([]);
		refetchTrackerTemplateMock.mockReset();
		refetchTrackerTemplateMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		clearCoauthorEditorSnapshotStateForTests();
		__isSending = false;
		globalThis.fetch = realFetch;
		toast.warning = realToastWarning;
		// Restore the real stores to their defaults so the in-process state does
		// not leak a test character / turn into other files.
		useSnapshotStore.getState().clear();
		useBootstrapStore.setState({ data: null });
		useCoauthorTurnStore.setState({ turnsByChat: {} });
	});

	it("renders the active character's MD body (prose headings + content, no frontmatter name)", () => {
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, getByText } = render(<CoauthorCharacterForm />);
		// The editor host always renders (independent of CM mounting).
		expect(container.querySelector(".vibe-md-editor")).toBeTruthy();
		// Header shows the character name.
		expect(getByText("Kira")).toBeTruthy();
		// CM body (graceful skip if CM did not mount in happy-dom).
		const content = container.querySelector(".cm-content");
		if (!content) return;
		const text = content.textContent ?? "";
		expect(text).toContain("PERSONALITY");
		expect(text).toContain("arachnid weaver");
		expect(text).toContain("SCENARIO");
		// Frontmatter name lives outside the editor body.
		expect(text).not.toContain("Kira");
	});

	it("idle: editor is editable and the header shows the saved subtitle", () => {
		__isSending = false;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, getByText, queryAllByText } = render(<CoauthorCharacterForm />);
		// Saved subtitle (i18n key returned verbatim by the mock).
		expect(getByText("saved_state")).toBeTruthy();
		// Lock affordance is NOT shown while idle.
		const matches = queryAllByText("coauthor.editor.locked");
		expect(matches.length).toBe(0);
		// Editable (graceful skip if CM did not mount).
		const editable = cmEditable(container);
		if (editable !== null) expect(editable).not.toBe("false");
	});

	it("generating (isSending): editor locks and the 'AI is editing…' affordance shows", () => {
		__isSending = true;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, getAllByText } = render(<CoauthorCharacterForm />);
		// Lock affordance (i18n key returned verbatim by the mock).
		// Use getAllByText — the scrim also renders the same key during generation.
		expect(getAllByText("coauthor.editor.locked").length).toBeGreaterThanOrEqual(1);
		// Locked (graceful skip if CM did not mount).
		const editable = cmEditable(container);
		if (editable !== null) expect(editable).toBe("false");
	});

	// ── Generation scrim (COAUTHOR_GENERATION_MUTATION_GUARDS) ──────────────
	// The scrim is a dim overlay with pointer-events-auto that renders over the
	// editor body while generating. It intercepts clicks to CodeMirror widget
	// decorations (greeting add/remove buttons) that bypass the EditorView.editable
	// facet, and provides the visual frozen-surface cue.

	it("generation scrim renders over the editor body while generating", () => {
		__isSending = true;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, getAllByText } = render(<CoauthorCharacterForm />);
		// Scrim label is the same i18n key as the header subtitle.
		expect(getAllByText("coauthor.editor.locked").length).toBeGreaterThanOrEqual(1);
		// The scrim must have the dim variant classes and intercept pointers.
		const scrim = container.querySelector("[class*='pointer-events-auto']");
		expect(scrim).toBeTruthy();
		expect((scrim as HTMLElement)?.className ?? "").toContain("bg-surface/55");
		// Spinner is rendered.
		expect(container.querySelector(".animate-spin")).toBeTruthy();
	});

	it("generation scrim is gone when isSending returns to false (lock released)", async () => {
		__isSending = true;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { rerender, queryAllByText } = render(<CoauthorCharacterForm />);
		expect(queryAllByText("coauthor.editor.locked")).toBeTruthy();

		__isSending = false;
		rerender(<CoauthorCharacterForm />);
		// AnimatePresence holds the exiting element briefly; waitFor polls until gone.
		await waitFor(() => {
			expect(queryAllByText("coauthor.editor.locked")).toHaveLength(0);
		});
	});

	it("locks when a generation starts mid-session (reconfigure effect)", () => {
		// Mount idle, then flip isSending and re-render — exercises the lock
		// EFFECT (Compartment reconfigure), not just the initial facet value.
		__isSending = false;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, rerender, queryAllByText, getAllByText } = render(<CoauthorCharacterForm />);
		expect(queryAllByText("coauthor.editor.locked").length).toBe(0);

		__isSending = true;
		rerender(<CoauthorCharacterForm />);
		expect(getAllByText("coauthor.editor.locked").length).toBeGreaterThanOrEqual(1);
		const editable = cmEditable(container);
		if (editable !== null) expect(editable).toBe("false");
	});

	it("falls back to the placeholder when there is no active character", () => {
		useSnapshotStore.setState({ character: null });
		const { getByText, container } = render(<CoauthorCharacterForm />);
		expect(getByText("coauthor.diff.placeholder")).toBeTruthy();
		// No editor host in the placeholder state.
		expect(container.querySelector(".vibe-md-editor")).toBeNull();
	});

	it("renders the lore assistant button with the co-author default when unset", () => {
		setLoreModel(null);
		useSnapshotStore.setState({ character: makeCharacter() });
		const { getByRole, getByText } = render(<CoauthorCharacterForm />);
		expect(getByRole("button", { name: "coauthor.lore_assistant.title" })).toBeTruthy();
		expect(getByText("coauthor.lore_assistant.same_as_coauthor")).toBeTruthy();
	});

	it("renders the chosen lore model name in the character-form button", () => {
		setLoreModel("lore-model");
		useSnapshotStore.setState({ character: makeCharacter() });
		const { getByText } = render(<CoauthorCharacterForm />);
		expect(getByText("lore-model")).toBeTruthy();
	});

	it("CE-C1: picker trigger is disabled while generating (mutation guard)", () => {
		// During generation the LinkBindingPopover trigger must be visually +
		// functionally disabled so the user cannot open the picker and silently
		// fail to persist context-link changes. This complements the handleSetContextLinks
		// early-return guard (defense in depth).
		__isSending = true;
		useSnapshotStore.setState({
			character: makeCharacter(),
			activeChat: { id: TEST_CHAT } as unknown as ActiveChat,
		});
		const { container } = render(<CoauthorCharacterForm />);
		// The trigger button is the '+' button inside LinkBindingPopover.
		const trigger = container.querySelector('button[aria-label]');
		expect(trigger).toBeTruthy();
		expect((trigger as HTMLButtonElement).disabled).toBe(true);
	});

	it("CE-C1: renders a pinned character as a pill (typed context link → LinkBindingPopover)", () => {
		// The generalized picker reads typed coauthorContextLinks and resolves
		// each link's entity for the pill row. Seed a character + a pinned link
		// to it; the pill must render (character targets come from the snapshot's
		// allCharacters, not a list endpoint).
		useSnapshotStore.setState({
			character: makeCharacter(),
			allCharacters: [{
				id: "char_pinned", name: "Mira", subtitle: "", tags: [],
				avatarAssetId: null, avatarFullAssetId: null, avatarCropJson: null,
				avatarExt: null, avatarFullExt: null, updatedAt: "0",
			}],
			activeChat: { id: TEST_CHAT, coauthorContextLinks: [{ targetType: "character", targetId: "char_pinned" }] } as unknown as ActiveChat,
		});
		const { getByText } = render(<CoauthorCharacterForm />);
		expect(getByText("Mira")).toBeTruthy();
	});

	it("CE-C2/C3: context-level captions render so the L1/L2/L3 distinction is obvious", async () => {
		// The three levels each carry a caption stating what the model sees:
		// L1 full content, L2 lorebook names+titles, L3 script names+summaries.
		useSnapshotStore.setState({
			character: makeCharacter(),
			activeChat: { id: TEST_CHAT } as unknown as ActiveChat,
		});
		const { getByText, findByText } = render(<CoauthorCharacterForm />);
		// L1 caption renders immediately (not behind BoundResourcesField's load).
		// useT is mocked to return keys verbatim — assert the KEY renders, not the
		// translated prose (translation parity is covered by the i18n status check).
		expect(getByText("coauthor.context.caption_full")).toBeTruthy();
		// L2/L3 captions render once BoundResourcesField resolves its (mocked) reads.
		expect(await findByText("coauthor.context.bound_lorebooks_caption")).toBeTruthy();
		expect(await findByText("coauthor.context.bound_scripts_caption")).toBeTruthy();
	});

	// ── E5: context block scrolls AWAY, editor fills the phone screen ────────

	it("E5: mobile uses ONE page scroll — the context block rides it and the editor section can fill the screen", async () => {
		useSnapshotStore.setState({
			character: makeCharacter(),
			activeChat: { id: TEST_CHAT } as never,
		});
		const { container, getByTestId } = render(<CoauthorCharacterForm />);
		const block = getByTestId("coauthor-context-block");
		// The context block must NOT own a scroll or a height cap (owner re-spec
		// 2026-09-08: it scrolls away with the page — the original fix gave it a
		// nested 40vh scroll, which pinned the block at half the phone screen).
		expect(block.className).not.toContain("max-md:overflow");
		expect(block.className).not.toContain("max-h-");
		expect(block.className).not.toContain("overflow-y-auto"); // not even desktop — never a scroller
		// ONE page scroll: the form root itself is the scrolling container on
		// mobile (block flow — the flex column stays for desktop).
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("max-md:overflow-y-auto");
		expect(root.className).toContain("max-md:block");
		// D4 (v1.2.1), co-author instance (owner 2026-09-24): the sticky
		// glass-bar's ::before frost bleeds 20px past the bar, and
		// overflow-y:auto coerces overflow-x to auto — the bleed was a 20px
		// horizontal swipe-scroll on the Doc tab. Pinned so the clip never
		// silently disappears (same guard as BuildMode's container).
		expect(root.className).toContain("max-md:overflow-x-clip");
		// The editor section is at least a full screen tall, so once the context
		// is scrolled past, the editor occupies the whole phone viewport; the
		// editor box itself grows toward a full screen (min-height, never clips —
		// the md bundle is auto-growing by design).
		const pane = block.nextElementSibling as HTMLElement;
		expect(pane.className).toContain("max-md:min-h-[100dvh]");
		const host = pane.querySelector(".vibe-md-editor") as HTMLElement;
		expect(host.className).toContain("max-md:min-h-[calc(100dvh-140px)]");
		expect(host.style.minHeight).toBe(""); // inline min-height would beat the mobile class
	});

	// ── CA-11: reviewing state + Apply/Reject ──────────────────────────────────
	// The turn store + chatId are what drive reviewing. The Apply RPC is
	// intercepted via globalThis.fetch (NOT chat-api mock.module — that would
	// collide with trace-history-store.test's chat-api mock; fetch is
	// collision-free). The corrections toast is spied by mutating the imported
	// `toast` singleton's `warning` method (no sonner mock.module → no collision
	// with gallery-store.test's sonner mock).

	const TEST_CHAT = "chat_test";

	function makeProfileActivity(
		toolCallId: string,
		personality: string,
		summary = "Made personality assertive.",
	): CoauthorToolActivity {
		const proposed = [
			"---",
			"name: Kira",
			"tags: []",
			"---",
			"",
			"# PERSONALITY",
			personality,
			"",
			"# SCENARIO",
			"A forest cave.",
			"",
			"# EXAMPLES",
			"{{char}}: *tilts head*",
			"",
		].join("\n");
		return { toolCallId, toolName: "write_profile", status: "done", target: "profile", proposed, summary };
	}

	/** Seed the snapshot with a character + an active co-author chat (for chatId). */
	function seedReviewing(characterOver: Partial<AppCharacter> = {}): AppCharacter {
		const character = makeCharacter(characterOver);
		useSnapshotStore.setState({ character, activeChat: { id: TEST_CHAT, mode: "coauthor" } as unknown as ActiveChat });
		return character;
	}

	it("reviewing: entered when a turn ends with a finalized proposal (!isSending + turn store)", () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "Bold and direct."));
		const { getByText } = render(<CoauthorCharacterForm />);
		// Reviewing state label + Apply/Reject affordances.
		expect(getByText("coauthor.review.state")).toBeTruthy();
		expect(getByText("coauthor.review.apply")).toBeTruthy();
		expect(getByText("coauthor.review.reject")).toBeTruthy();
		// The diff title is shown.
		expect(getByText("coauthor.review.title")).toBeTruthy();
	});

	it("reviewing: NOT entered for streaming/error activities (only done+proposed)", () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(
			TEST_CHAT,
			{ toolCallId: "t1", toolName: "write_profile", status: "streaming" },
		);
		const { getByText } = render(<CoauthorCharacterForm />);
		expect(() => getByText("coauthor.review.state")).toThrow(); // idle, not reviewing
		expect(getByText("saved_state")).toBeTruthy();
	});

	it("Apply: commits via the CA-7 RPC, ingests the snapshot, clears the turn, returns to idle", async () => {
		__isSending = false;
		seedReviewing({ description: "A reserved arachnid weaver." });
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "Bold and direct."));

		const fetchMock = mock((_url: unknown, _init: unknown) =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({
					character: makeCharacter({ description: "Bold and direct." }),
					corrections: [],
				}),
				text: async () => "",
			}),
		);
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		expect(getByText("coauthor.review.apply")).toBeTruthy();

		await waitFor(() => {
			// Clicking Apply kicks off the async RPC; waitFor flushes it.
		});
		fireEvent.click(getByText("coauthor.review.apply"));

		await waitFor(() => {
			// The RPC fired against the Apply endpoint.
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
			expect(String(call[0])).toContain("/coauthor/apply");
			expect(String(call[0])).toContain(TEST_CHAT);
			// Apply routes through the aggregated profileMd (never a raw string-swap).
			expect(String(call[1]?.body ?? "")).toContain("profileMd");
		});
		await waitFor(() => {
			// Turn store cleared → reviewing falls to idle (overlay gone).
			expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
		});
	});

	it("Apply: renders backend corrections as a toast (R3 — empty name restored)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "Bold."));

		const warningSpy = mock(() => {});
		toast.warning = warningSpy as never;

		globalThis.fetch = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({
					character: makeCharacter({ name: "Kira" }),
					corrections: [
						{ field: "name", action: "restored", reason: 'Model returned an empty name; restored "Kira".' },
					],
				}),
				text: async () => "",
			}),
		) as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.apply"));

		await waitFor(() => {
			expect(warningSpy).toHaveBeenCalledTimes(1);
		});
		const firstCall = (warningSpy.mock.calls[0] ?? []) as unknown[];
		expect(String(firstCall[0] ?? "")).toContain("name");
		expect(String(firstCall[0] ?? "")).toContain("Kira");
	});

	it("Reject: discards the proposal without an RPC and returns to idle", () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "Bold."));

		const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.reject"));

		// No RPC fired — Reject is local-only (discards the in-turn proposal).
		expect(fetchMock).not.toHaveBeenCalled();
		// Turn store cleared → idle.
		expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
	});

	afterAll(() => {
		restoreCoauthorEditorSnapshotStateForTests(originalSnapshotState);
		useSnapshotStore.setState(originalAppSnapshotState, true);
		useBootstrapStore.setState(originalBootstrapState, true);
		useCoauthorTurnStore.setState(originalTurnState, true);
		globalThis.fetch = realFetch;
		toast.warning = realToastWarning;
	});

	it("RO-5: mounted live editor state rides the actual non-stream and stream HTTP bodies", async () => {
		useSnapshotStore.setState({
			character: makeCharacter({ name: "", firstMessage: "", alternateGreetings: [""] }),
			activeChat: { id: TEST_CHAT, mode: "coauthor" } as unknown as ActiveChat,
		});
		const requests: string[] = [];
		const fetchMock = mock(async (_url: unknown, init: RequestInit | undefined) => {
			requests.push(String(init?.body ?? ""));
			if (requests.length === 1) {
				return new Response(JSON.stringify({ character: makeCharacter(), corrections: [] }), { status: 200 });
			}
			return new Response('data: {"finishReason":"stop"}\n\n', { status: 200 });
		});
		Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock, writable: true });

		const { container, getByText } = render(<CoauthorCharacterForm />);
		const content = container.querySelector(".cm-content") as HTMLElement | null;
		expect(content).toBeTruthy();
		const view = content ? EditorView.findFromDOM(content) : null;
		expect(view).toBeTruthy();
		const initialBody = view?.state.doc.toString() ?? "";
		const from = initialBody.indexOf("A reserved arachnid weaver.");
		expect(from).toBeGreaterThanOrEqual(0);
		view?.dispatch({ changes: { from, to: from + "A reserved arachnid weaver.".length, insert: "Live editor body" } });
		await waitFor(() => expect(getByText("unsaved_changes")).toBeTruthy());

		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "normal" });
		await sendStream(TEST_CHAT, { content: "stream" }, {
			onStatus: () => {}, onChunk: () => {},
		});

		expect(requests).toHaveLength(2);
		for (const raw of requests) {
			const body = JSON.parse(raw);
			expect(body.coauthorEditorState.card.name).toBe("");
			expect(body.coauthorEditorState.card.body).toContain("Live editor body");
			expect(body.coauthorEditorState.card.greetings).toEqual([""]);
			expect(body.coauthorEditorState.card.cardClean).toBe(false);
			expect(body.coauthorEditorState.review).toEqual({ targets: [] });
		}
	});

	it("RO-5: mounted empty editor values ride the actual non-stream and stream HTTP bodies", async () => {
		useSnapshotStore.setState({
			character: makeCharacter({ name: "", description: "", scenario: "", mesExample: "", firstMessage: "", alternateGreetings: [] }),
			activeChat: { id: TEST_CHAT, mode: "coauthor" } as unknown as ActiveChat,
		});
		const requests: string[] = [];
		const fetchMock = mock(async (_url: unknown, init: RequestInit | undefined) => {
			requests.push(String(init?.body ?? ""));
			if (requests.length === 1) {
				return new Response(JSON.stringify({ character: makeCharacter(), corrections: [] }), { status: 200 });
			}
			return new Response('data: {"finishReason":"stop"}\n\n', { status: 200 });
		});
		Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock, writable: true });

		render(<CoauthorCharacterForm />);
		await waitFor(() => expect(readCoauthorEditorState(TEST_CHAT, "char_test")).toBeDefined());
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "normal empty" });
		await sendStream(TEST_CHAT, { content: "stream empty" }, {
			onStatus: () => {}, onChunk: () => {},
		});

		expect(requests).toHaveLength(2);
		for (const raw of requests) {
			const body = JSON.parse(raw);
			expect(body.coauthorEditorState.card.name).toBe("");
			expect(body.coauthorEditorState.card.body).toContain("# PERSONALITY");
			expect(body.coauthorEditorState.card.body).not.toContain("A reserved arachnid weaver.");
			expect(body.coauthorEditorState.card.greetings).toEqual([""]);
			expect(body.coauthorEditorState.card.cardClean).toBe(true);
			expect(body.coauthorEditorState.review).toEqual({ targets: [] });
		}
	});

	// ── CTX-L3: lore proposal reviewing + Apply / Reject ───────────────────────
	// A lore-only turn (no profile/greeting) must still enter Reviewing, render the
	// structured lore surface, and commit the user's per-item selection via Apply.
	// Parent-dependency is enforced at the Apply boundary: deselecting a lorebook
	// drops its entries from the shipped bundle (selectLoreBundle).

	function makeTrackerTemplateActivity(): CoauthorToolActivity {
		const trackerTemplate = normalizeTrackerTemplate({
			version: 1,
			scene: { enabled: true, config: { schema: { location: { $type: "string" } } } },
		});
		if (!trackerTemplate) throw new Error("Expected fixture tracker template to normalize");
		return {
			toolCallId: "tracker-1",
			toolName: "set_tracker_template",
			status: "done",
			summary: "Drafted detective trackers.",
			trackerTemplate,
		};
	}

	function makeLoreActivity(): CoauthorToolActivity {
		return {
			toolCallId: "l1",
			toolName: "create_lore_entry",
			status: "done",
			summary: "Drafted lore.",
			loreBundle: {
				lorebooks: [
					{ id: "lb1", name: "World Lore", description: "", scopeType: "global", enabled: true },
					{ id: "lb2", name: "Char Lore", description: "", scopeType: "entity", enabled: true },
				],
				entries: [
					{ id: "e1", lorebookId: "lb1", title: "Eldoria", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
					{ id: "e2", lorebookId: "lb2", title: "Vex", content: "c2", keys: ["k2"], secondaryKeys: [], constant: true, position: "before_char", depth: 4, enabled: true },
				],
			},
		};
	}

	it("CT-7b: a tracker-template card applies only when included and refreshes its character-template hook", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const fetchMock = mock((_u: RequestInfo | URL, _i?: RequestInit) =>
			Promise.resolve(new Response(JSON.stringify({ character: makeCharacter(), corrections: [] }), { status: 200 })),
		);
		Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock, writable: true });

		const { getByRole, getByText } = render(<CoauthorCharacterForm />);
		expect(getByText("coauthor.tracker_template.review.title")).toBeTruthy();
		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => {
			const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
			const body = JSON.parse(String(call[1]?.body ?? "{}"));
			expect(body.trackerTemplate.scene.config.schema.location.$type).toBe("string");
			expect(refetchTrackerTemplateMock).toHaveBeenCalledTimes(1);
		});

		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		await waitFor(() => expect(getByText("coauthor.tracker_template.review.title")).toBeTruthy());
		fireEvent.click(getByRole("checkbox"));
		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const call = fetchMock.mock.calls[1] as unknown as [unknown, RequestInit | undefined];
			const body = JSON.parse(String(call[1]?.body ?? "{}"));
			expect(body.trackerTemplate).toBeUndefined();
		});
	});

	it("RO-5 supervisor: Reject leaves no card hunks pending in two following HTTP requests", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		const requests: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({ character: makeCharacter() }), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.queryByText("coauthor.review.reject")).not.toBeNull());
		fireEvent.click(utils.getByText("coauthor.review.reject"));
		await waitFor(() => expect(utils.queryByText("coauthor.review.reject")).toBeNull());

		for (const content of ["first after rejection", "second after rejection"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			const card = requests.at(-1)?.coauthorEditorState?.review.targets.find((target) => target.target === "card");
			expect(card).toMatchObject({ outcome: "rejected", hunks: { accepted: 0, rejected: 2, pending: 0 } });
		}
	});

	it("RO-5 supervisor: unresolved review survives the real turn-store clear boundary before HTTP send", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		const requests: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({ character: makeCharacter() }), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.queryByText("coauthor.review.reject")).not.toBeNull());
		const before = readCoauthorEditorState(TEST_CHAT, "char_test")?.review;
		expect(before?.targets.find((target) => target.target === "card")?.outcome).toBe("awaiting");

		// Both production send modes clear this exact ephemeral store before their HTTP call.
		await act(async () => {
			__isSending = true;
			useCoauthorTurnStore.getState().clearTurn(TEST_CHAT);
			utils.rerender(<CoauthorCharacterForm />);
		});
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "keep unfinished changes" });
		expect(requests.at(-1)?.coauthorEditorState?.review).toEqual(before);

		await act(async () => {
			__isSending = false;
			utils.rerender(<CoauthorCharacterForm />);
		});
		expect(utils.queryByText("coauthor.review.reject")).not.toBeNull();
	});

	it("RO-5: mounted selections survive clear and remount, then drive Apply and the following review snapshot", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		let applyRequest: ReturnType<typeof coauthorApplySchema.parse> | undefined;
		const fetchHandler = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				applyRequest = coauthorApplySchema.parse(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({ character: makeCharacter({ scenario: "A forest cave at dusk." }), corrections: [] }), { status: 200 });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({ character: makeCharacter() }), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		globalThis.fetch = fetchHandler;
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.getAllByRole("checkbox")).toHaveLength(7));
		const initial = utils.getAllByRole("checkbox");
		fireEvent.click(initial[1]!); // Keep only the first card hunk.
		fireEvent.click(initial[2]!); // Reject the tracker wholesale.
		fireEvent.click(initial[3]!); // Reject the first lorebook and its entry.
		await act(async () => {
			__isSending = true;
			useCoauthorTurnStore.getState().clearTurn(TEST_CHAT);
			utils.rerender(<CoauthorCharacterForm />);
			__isSending = false;
			utils.rerender(<CoauthorCharacterForm />);
		});
		utils.unmount();
		const remounted = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(remounted.getAllByRole("checkbox").map(ariaChecked)).toEqual([true, false, false, false, true, true, true]));
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "preserved choices" });
		const awaiting = sent.at(-1)?.coauthorEditorState?.review.targets;
		expect(awaiting).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", hunks: { accepted: 0, rejected: 1, pending: 1 } }),
			expect.objectContaining({ target: "lore", items: { offered: 4, selected: 2, applied: 0 } }),
			expect.objectContaining({ target: "tracker_template", selected: false }),
		]));
		fireEvent.click(remounted.getByText("coauthor.review.apply"));
		await waitFor(() => expect(remounted.queryByText("coauthor.review.apply")).toBeNull());
		expect(applyRequest?.profileMd).toContain("Bold and direct.");
		expect(applyRequest?.profileMd).not.toContain("A forest cave at dusk.");
		expect(applyRequest?.loreBundle?.lorebooks.map((item) => item.id)).toEqual(["lb2"]);
		expect(applyRequest?.loreBundle?.entries.map((item) => item.id)).toEqual(["e2"]);
		expect(applyRequest?.trackerTemplate).toBeUndefined();
		expect(readCoauthorEditorState(TEST_CHAT, "char_test")?.card.body).toContain("A forest cave at dusk.");
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "applied choices" });
		expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "applied-partial" }),
			expect.objectContaining({ target: "lore", outcome: "applied-partial", items: expect.objectContaining({ applied: 2 }) }),
			expect.objectContaining({ target: "tracker_template", outcome: "rejected", selected: false }),
		]));
	});

	it("RO-5: same-character chat scopes isolate selections and reset only a replaced target", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.getAllByRole("checkbox")).toHaveLength(7));
		fireEvent.click(utils.getAllByRole("checkbox")[1]!);
		fireEvent.click(utils.getAllByRole("checkbox")[2]!);
		await act(async () => {
			useSnapshotStore.setState({ activeChat: { id: "chat_other", mode: "coauthor" } as unknown as ActiveChat });
			useCoauthorTurnStore.getState().upsertActivity("chat_other", twoHunkProfileActivity());
		});
		await waitFor(() => expect(utils.getAllByRole("checkbox").map(ariaChecked)).toEqual([true, true]));
		await act(async () => {
			useSnapshotStore.setState({ activeChat: { id: TEST_CHAT, mode: "coauthor" } as unknown as ActiveChat });
		});
		await waitFor(() => expect(utils.getAllByRole("checkbox").map(ariaChecked)).toEqual([true, false, false, true, true, true, true]));
		const replacementLore = makeLoreActivity();
		const replacementBundle = replacementLore.loreBundle!;
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, {
			...replacementLore,
			loreBundle: { ...replacementBundle, entries: replacementBundle.entries.map((entry) => ({ ...entry, content: `${entry.content} New.` })) },
		});
		await waitFor(() => expect(utils.getAllByRole("checkbox").map(ariaChecked)).toEqual([true, false, false, true, true, true, true]));
	});

	it("RO-5: full Apply records all three targets only after the parked RPC resolves", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		let resolveResponse: ((response: Response) => void) | undefined;
		const fetchMock = mock(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) return fetchMock();
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const pending = readCoauthorEditorState(TEST_CHAT, "char_test")?.review.targets;
		expect(pending).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "awaiting", hunks: expect.objectContaining({ accepted: 0 }) }),
			expect.objectContaining({ target: "lore", outcome: "awaiting", items: expect.objectContaining({ applied: 0 }) }),
			expect.objectContaining({ target: "tracker_template", outcome: "awaiting", selected: true }),
		]));
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "before full Apply confirmation" });
		expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual(pending);

		resolveResponse?.(new Response(JSON.stringify({ character: makeCharacter({ description: "Bold and direct." }), corrections: [] }), { status: 200 }));
		await waitFor(() => {
			const resolved = readCoauthorEditorState(TEST_CHAT, "char_test")?.review.targets;
			expect(resolved).toEqual(expect.arrayContaining([
				expect.objectContaining({ target: "card", outcome: "applied" }),
				expect.objectContaining({ target: "lore", outcome: "applied", items: expect.objectContaining({ applied: 4 }) }),
				expect.objectContaining({ target: "tracker_template", outcome: "applied", selected: true }),
			]));
		});
		for (const content of ["after full Apply", "second following full Apply turn"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			const state = sent.at(-1)?.coauthorEditorState;
			expect(state?.review.targets).toHaveLength(3);
			expect(state?.review.targets.every((target) => target.outcome === "applied")).toBe(true);
			expect(state?.review.targets.map((target) => target.roundId)).toEqual(pending?.map((target) => target.roundId));
			expect(state?.card.body).toContain("Bold and direct.");
			expect(state?.card.cardClean).toBe(true);
		}
	});

	it("RO-5 supervisor: whole Reject preserves terminal outcomes for all targets on later turns", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		const before = readCoauthorEditorState(TEST_CHAT, "char_test");
		expect(before?.review.targets).toHaveLength(3);
		fireEvent.click(utils.getByText("coauthor.review.reject"));
		await waitFor(() => expect(utils.queryByText("coauthor.review.reject")).toBeNull());
		for (const content of ["first rejected turn", "second rejected turn"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			const state = sent.at(-1)?.coauthorEditorState;
			expect(state?.card).toEqual(before?.card);
			expect(state?.review.targets).toEqual([
				expect.objectContaining({ target: "card", outcome: "rejected", hunks: { accepted: 0, rejected: 2, pending: 0 } }),
				expect.objectContaining({ target: "lore", outcome: "rejected", items: { offered: 4, selected: 4, applied: 0 } }),
				expect.objectContaining({ target: "tracker_template", outcome: "rejected", selected: true }),
			]);
			expect(state?.review.targets.map((target) => target.roundId)).toEqual(before?.review.targets.map((target) => target.roundId));
		}
	});

	it("RO-5 supervisor: frontmatter-only card Apply publishes its confirmed name and wholesale outcome", async () => {
		seedReviewing();
		const activity = makeProfileActivity("rename", "A reserved arachnid weaver.");
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, { ...activity, proposed: activity.proposed?.replace("name: Kira", "name: Renamed") });
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		let applied: ReturnType<typeof coauthorApplySchema.parse> | undefined;
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				applied = coauthorApplySchema.parse(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({ character: makeCharacter({ name: "Renamed" }), corrections: [] }), { status: 200 });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		expect(utils.queryAllByRole("checkbox")).toHaveLength(0);
		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(utils.queryByText("coauthor.review.apply")).toBeNull());
		expect(applied?.profileMd).toContain("name: Renamed");
		for (const content of ["first renamed turn", "second renamed turn"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			expect(sent.at(-1)?.coauthorEditorState?.card).toMatchObject({ name: "Renamed", cardClean: true });
			expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual([
				expect.objectContaining({ target: "card", outcome: "applied", hunks: { accepted: 1, rejected: 0, pending: 0 } }),
			]);
		}
	});

	it("RO-5: a parked mixed-target Apply failure stays awaiting and a retry publishes only confirmed partial outcomes", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		let applyAttempts = 0;
		let resolveAttempt!: (response: Response) => void;
		const appliedRequests: ReturnType<typeof coauthorApplySchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				applyAttempts += 1;
				appliedRequests.push(coauthorApplySchema.parse(JSON.parse(String(init?.body))));
				return new Promise<Response>((resolve) => { resolveAttempt = resolve; });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({ character: makeCharacter() }), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.getAllByRole("checkbox")).toHaveLength(7));
		const choices = utils.getAllByRole("checkbox");
		fireEvent.click(choices[1]!); // one card hunk remains
		fireEvent.click(choices[2]!); // tracker is offered but not selected
		fireEvent.click(choices[3]!); // first lorebook and its entry are rejected
		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(applyAttempts).toBe(1));
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "Apply is still pending" });
		const awaiting = sent.at(-1)?.coauthorEditorState?.review;
		expect(awaiting?.targets.every((target) => target.outcome === "awaiting")).toBe(true);
		await act(async () => {
			resolveAttempt(new Response(JSON.stringify({ error: { message: "Apply failed" } }), { status: 500 }));
		});
		expect(utils.queryByText("coauthor.review.apply")).not.toBeNull();

		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "retry remains awaiting" });
		expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "awaiting", hunks: { accepted: 0, rejected: 1, pending: 1 } }),
			expect.objectContaining({ target: "lore", outcome: "awaiting", items: { offered: 4, selected: 2, applied: 0 } }),
			expect.objectContaining({ target: "tracker_template", outcome: "awaiting", selected: false }),
		]));
		expect(sent.at(-1)?.coauthorEditorState?.review).toEqual(awaiting);

		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(applyAttempts).toBe(2));
		expect(appliedRequests[1]).toEqual(appliedRequests[0]);
		expect(appliedRequests[1]?.profileMd).toContain("Bold and direct.");
		expect(appliedRequests[1]?.profileMd).not.toContain("A forest cave at dusk.");
		expect(appliedRequests[1]?.loreBundle?.lorebooks.map((item) => item.id)).toEqual(["lb2"]);
		expect(appliedRequests[1]?.loreBundle?.entries.map((item) => item.id)).toEqual(["e2"]);
		expect(appliedRequests[1]?.trackerTemplate).toBeUndefined();
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "retry is still pending" });
		expect(sent.at(-1)?.coauthorEditorState?.review).toEqual(awaiting);
		await act(async () => {
			resolveAttempt(new Response(JSON.stringify({ character: makeCharacter({ description: "Bold and direct." }), corrections: [] }), { status: 200 }));
		});
		await waitFor(() => expect(utils.queryByText("coauthor.review.apply")).toBeNull());
		for (const content of ["retry confirmed", "second following turn"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			expect(sent.at(-1)?.coauthorEditorState?.card).toMatchObject({ cardClean: true });
			expect(sent.at(-1)?.coauthorEditorState?.card.body).toContain("Bold and direct.");
			expect(sent.at(-1)?.coauthorEditorState?.review.targets.map((target) => target.roundId)).toEqual(awaiting?.targets.map((target) => target.roundId));
		}
		expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "applied-partial", hunks: { accepted: 1, rejected: 1, pending: 0 } }),
			expect.objectContaining({ target: "lore", outcome: "applied-partial", items: { offered: 4, selected: 2, applied: 2 } }),
			expect.objectContaining({ target: "tracker_template", outcome: "rejected", selected: false }),
		]));
		const confirmed = sent.at(-1)?.coauthorEditorState?.review;
		const content = utils.container.querySelector<HTMLElement>(".cm-content");
		expect(content).not.toBeNull();
		const editor = content ? EditorView.findFromDOM(content) : null;
		expect(editor).not.toBeNull();
		const body = editor?.state.doc.toString() ?? "";
		const from = body.indexOf("Bold and direct.");
		expect(from).toBeGreaterThanOrEqual(0);
		await act(async () => {
			editor?.dispatch({ changes: { from, to: from + "Bold and direct.".length, insert: "Manually refined after Apply." } });
		});
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "manual edit after Apply" });
		expect(sent.at(-1)?.coauthorEditorState?.card).toMatchObject({ cardClean: false });
		expect(sent.at(-1)?.coauthorEditorState?.card.body).toContain("Manually refined after Apply.");
		expect(sent.at(-1)?.coauthorEditorState?.review).toEqual(confirmed);
	});

	it("RO-6 bridge: writes the mounted partial-Apply request for the in-process server proof", async () => {
		const bridgeOutput = process.env.VT_REVIEW_OUTCOME_BRIDGE_OUTPUT;
		if (bridgeOutput === undefined) return;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				return new Response(JSON.stringify({ character: makeCharacter({ description: "Bold and direct." }), corrections: [] }), { status: 200 });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(utils.getAllByRole("checkbox")).toHaveLength(7));
		const choices = utils.getAllByRole("checkbox");
		fireEvent.click(choices[1]!);
		fireEvent.click(choices[2]!);
		fireEvent.click(choices[3]!);
		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(utils.queryByText("coauthor.review.apply")).toBeNull());
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "RO-6 mounted coauthor bridge" });
		const request = sent[0];
		if (!request) throw new Error("Expected the mounted co-author action to send a request");
		await Bun.write(bridgeOutput, JSON.stringify(request));
	});

	it("RO-5 supervisor: Apply settled in another chat cannot resurrect the completed proposal on return", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("parked-profile", "Confirmed while away."));
		let resolveApply!: (response: Response) => void;
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				return new Promise<Response>((resolve) => { resolveApply = resolve; });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const first = render(<CoauthorCharacterForm />);
		fireEvent.click(first.getByText("coauthor.review.apply"));
		await waitFor(() => expect(resolveApply).toBeDefined());
		const before = readCoauthorEditorState(TEST_CHAT, "char_test")?.review.targets;
		expect(before).toHaveLength(1);
		expect(before?.[0]?.outcome).toBe("awaiting");
		first.unmount();
		await act(async () => {
			useSnapshotStore.setState({ activeChat: { id: "chat_other", mode: "coauthor" } as unknown as ActiveChat });
		});
		const other = render(<CoauthorCharacterForm />);
		await act(async () => {
			resolveApply(new Response(JSON.stringify({ character: makeCharacter({ description: "Confirmed while away." }), corrections: [] }), { status: 200 }));
		});
		expect(useSnapshotStore.getState().activeChat?.id).toBe(brandId<ChatId>("chat_other"));
		expect(useSnapshotStore.getState().character?.description).toBe("A reserved arachnid weaver.");
		other.unmount();
		await act(async () => {
			seedReviewing({ description: "Confirmed while away." });
		});
		const returned = render(<CoauthorCharacterForm />);
		for (const content of ["first turn after return", "second turn after return"]) {
			await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content });
			expect(sent.at(-1)?.coauthorEditorState?.review.targets).toEqual([
				expect.objectContaining({ target: "card", roundId: before?.[0]?.roundId, outcome: "applied" }),
			]);
		}
		expect(returned.queryByText("coauthor.review.apply")).toBeNull();
	});

	it("RO-5: an Apply settlement leaves a newer same-chat proposal intact", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("origin", "Origin proposal."));
		let resolveOrigin!: (response: Response) => void;
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				return new Promise<Response>((resolve) => { resolveOrigin = resolve; });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({}), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(resolveOrigin).toBeDefined());
		await act(async () => {
			useCoauthorTurnStore.getState().clearTurn(TEST_CHAT);
			useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("replacement", "Newer proposal."));
		});
		await act(async () => {
			resolveOrigin(new Response(JSON.stringify({ character: makeCharacter({ description: "Origin proposal." }), corrections: [] }), { status: 200 }));
		});
		await waitFor(() => expect(utils.queryByText("coauthor.review.apply")).not.toBeNull());
		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "newer proposal remains" });
		const targets = sent.at(-1)?.coauthorEditorState?.review.targets;
		expect(targets).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "awaiting" }),
			expect.objectContaining({ target: "card", outcome: "superseded" }),
		]));
		expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT).map((activity) => activity.toolCallId)).toEqual(["replacement"]);
	});

	it("RO-5: a tracker refresh failure cannot restore the pre-Apply editor snapshot", async () => {
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("profile", "Confirmed editor body."));
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeTrackerTemplateActivity());
		refetchTrackerTemplateMock.mockRejectedValueOnce(new Error("tracker refresh failed"));
		const sent: ReturnType<typeof sendMessageSchema.parse>[] = [];
		globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/coauthor/apply")) {
				return new Response(JSON.stringify({ character: makeCharacter({ description: "Confirmed editor body." }), corrections: [] }), { status: 200 });
			}
			sent.push(sendMessageSchema.parse(JSON.parse(String(init?.body))));
			return new Response(JSON.stringify({ character: makeCharacter() }), { status: 200 });
		}, { preconnect: realFetch.preconnect });
		const utils = render(<CoauthorCharacterForm />);
		fireEvent.click(utils.getByText("coauthor.review.apply"));
		await waitFor(() => expect(refetchTrackerTemplateMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]));

		await sendChatMessage(brandId<ChatId>(TEST_CHAT), { content: "after refresh failure" });
		const state = sent.at(-1)?.coauthorEditorState;
		expect(state?.card.body).toContain("Confirmed editor body.");
		expect(state?.review.targets).toEqual(expect.arrayContaining([
			expect.objectContaining({ target: "card", outcome: "applied" }),
			expect.objectContaining({ target: "tracker_template", outcome: "applied" }),
		]));
	});

	it("CTX-L3: a lore-only turn enters Reviewing and Apply ships the wholesale loreBundle (no profileMd)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		// Lore-only reviewing: the lore review title is shown.
		expect(getByText("coauthor.lore.review.title")).toBeTruthy();
		expect(getByText("coauthor.review.apply")).toBeTruthy();

		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
			expect(String(call[0])).toContain("/coauthor/apply");
			const body = JSON.parse(String(call[1]?.body ?? "{}"));
			// loreBundle ships wholesale (both books + entries); profile/greeting omitted.
			expect(body.profileMd).toBeUndefined();
			expect(body.loreBundle.lorebooks).toHaveLength(2);
			expect(body.loreBundle.entries).toHaveLength(2);
		});
		await waitFor(() => {
			expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
		});
	});

	it("CE-B2: Apply preserves generated keys for entries whose lorebook is already persisted", async () => {
		__isSending = false;
		seedReviewing();
		const generatedKeys = ["skinwalker", "mimic", "consume memories"];
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, {
			toolCallId: "keys-1",
			toolName: "ai_generate_lore_keys",
			status: "done",
			summary: "Generated keys.",
			loreBundle: {
				// Re-delegation imports only the persisted entry. Its existing parent
				// is intentionally absent from the proposal graph.
				lorebooks: [],
				entries: [{
					id: "e-persisted",
					lorebookId: "lb-persisted",
					title: "Skinwalker Biology & Evolution",
					content: "Existing content.",
					keys: generatedKeys,
					secondaryKeys: ["host"],
					constant: false,
					position: "before_char",
					depth: 4,
					enabled: true,
					mode: "edit",
					parentMode: "persisted",
				}],
			},
		});

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { getByRole, getByText } = render(<CoauthorCharacterForm />);
		await waitFor(() => expect(ariaChecked(getByRole("checkbox"))).toBe(true));
		fireEvent.click(getByText("coauthor.review.apply"));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
			const body = JSON.parse(String(call[1]?.body ?? "{}"));
			expect(body.loreBundle.lorebooks).toEqual([]);
			expect(body.loreBundle.entries).toHaveLength(1);
			expect(body.loreBundle.entries[0].keys).toEqual(generatedKeys);
			expect(body.loreBundle.entries[0].secondaryKeys).toEqual(["host"]);
		});
	});

	it("CTX-L3: applying lore refreshes the Co-Author lorebook option and binding lists", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		await waitFor(() => {
			expect(listAllLorebooksMock).toHaveBeenCalledTimes(2);
			expect(listCharacterLorebooksMock).toHaveBeenCalledTimes(1);
		});
		const createdLorebook = {
			id: "lb2",
			name: "Char Lore",
			description: "",
			scopeType: "entity",
			enabled: true,
		} as LorebookRecord;
		listAllLorebooksMock.mockResolvedValue([createdLorebook]);
		listCharacterLorebooksMock.mockResolvedValue([createdLorebook]);

		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => {
			expect(listAllLorebooksMock.mock.calls.length).toBeGreaterThan(2);
			expect(listCharacterLorebooksMock.mock.calls.length).toBeGreaterThan(1);
		});
	});

	it("CTX-L3: Apply with a deselected lorebook drops its entries (parent-dependency at the Apply boundary)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { getByText, getAllByRole } = render(<CoauthorCharacterForm />);
		// Checkboxes in DOM order: lb1, e1, lb2, e2. Deselect lb1 (index 0).
		const checks = getAllByRole("checkbox");
		fireEvent.click(checks[0]!);

		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
			const body = JSON.parse(String(call[1]?.body ?? "{}"));
			// lb1 rejected → only lb2 + e2 ship; e1 is orphaned by its rejected parent
			// and dropped (invalid child-without-parent prevention).
			expect(body.loreBundle.lorebooks.map((lb: { id: string }) => lb.id)).toEqual(["lb2"]);
			expect(body.loreBundle.entries.map((e: { id: string }) => e.id)).toEqual(["e2"]);
		});
	});

	it("CTX-L3: Reject discards a lore proposal without an RPC", () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.reject"));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
	});

	// ── CA-12: hunk-level (granular) Apply ────────────────────────────────────
	// The reviewing overlay renders each change hunk as a selectable block. The
	// user toggles hunks on/off; Apply rebuilds the request from the merged body
	// (selected hunks only). Default = all selected (CA-11 wholesale parity).

	/** A proposed profile.md that changes BOTH personality and scenario (2 hunks). */
	function twoHunkProfileActivity(): CoauthorToolActivity {
		const proposed = [
			"---", "name: Kira", "tags: []", "---", "",
			"# PERSONALITY", "Bold and direct.", "",
			"# SCENARIO", "A forest cave at dusk.", "",
			"# EXAMPLES", "{{char}}: *tilts head*", "",
		].join("\n");
		return { toolCallId: "t1", toolName: "write_profile", status: "done", target: "profile", proposed, summary: "Rewrote personality + scenario." };
	}

	it("CA-12: reviewing renders one checkbox per hunk, all selected by default", () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());

		const { container } = render(<CoauthorCharacterForm />);
		const boxes = container.querySelectorAll('[role="checkbox"]');
		// Two hunks (personality + scenario); greetings untouched → no greeting hunk.
		expect(boxes.length).toBe(2);
		expect([...boxes].every((b) => ariaChecked(b))).toBe(true); // all on (wholesale default)
	});

	it("CA-12: toggling a hunk off + Apply sends a PARTIAL request (rejected hunk reverts to canonical)", async () => {
		__isSending = false;
		// Canonical personality: "A reserved arachnid weaver."; scenario: "A forest cave."
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ character: makeCharacter({ description: "A reserved arachnid weaver.", scenario: "A forest cave at dusk." }), corrections: [] }),
				text: async () => "",
			}),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		const boxes = container.querySelectorAll('[role="checkbox"]');
		expect(boxes.length).toBe(2);
		// Deselect the FIRST hunk (personality) — keep the scenario hunk accepted.
		fireEvent.click(boxes[0]!);
		expect(ariaChecked(boxes[0]!)).toBe(false);
		expect(ariaChecked(boxes[1]!)).toBe(true);

		fireEvent.click(getByText("coauthor.review.apply"));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
		const body = String(call[1]?.body ?? "");
		expect(body).toContain("profileMd");
		// Rejected personality hunk → canonical personality preserved in the rebuilt profileMd.
		expect(body).toContain("A reserved arachnid weaver.");
		expect(body).not.toContain("Bold and direct.");
		// Accepted scenario hunk → proposed scenario in the rebuilt profileMd.
		expect(body).toContain("A forest cave at dusk.");
		await waitFor(() => {
			expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
		});
	});

	it("CA-12: all hunks selected (default) Apply is wholesale parity — proposed personality ships", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.apply")); // no toggling → all selected

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
		const body = String(call[1]?.body ?? "");
		// Wholesale: both proposed changes ship.
		expect(body).toContain("Bold and direct.");
		expect(body).toContain("A forest cave at dusk.");
	});

	// ── CED-7: operation input (args) is display-only ────────────────────────
	// CED-5/6 added the operation INPUT (`args`) to CoauthorToolActivity for the
	// tool-card preview. This regression proves that metadata does NOT alter the
	// reviewing overlay, hunk selection, or the Apply request: aggregation reads
	// `proposed` only. An edit_personality activity (which carries SEARCH/REPLACE
	// args) must behave exactly like a write_profile at the Apply boundary.

	it("CED-7: an edit_personality carrying `args` does not leak operation input into the Apply request", async () => {
		__isSending = false;
		seedReviewing({ description: "A reserved arachnid weaver." });
		// edit_personality returns a FULL cumulative profile.md (CED-2) and now
		// also carries the operation INPUT (args) for the card preview (CED-5/6).
		const proposed = [
			"---", "name: Kira", "tags: []", "---", "",
			"# PERSONALITY", "Bold and direct.", "",
			"# SCENARIO", "A forest cave.", "",
			"# EXAMPLES", "{{char}}: *tilts head*", "",
		].join("\n");
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, {
			toolCallId: "t1", toolName: "edit_personality", status: "done", target: "profile",
			proposed, summary: "sharpen personality",
			args: { edits: [{ search: "A reserved arachnid weaver.", replace: "Bold and direct." }], summary: "sharpen personality" },
		});

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter({ description: "Bold and direct." }), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Reviewing entered; exactly one hunk (personality changed; scenario/examples match canonical).
		expect(getByText("coauthor.review.state")).toBeTruthy();
		expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);

		fireEvent.click(getByText("coauthor.review.apply"));
		await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
		const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
		const body = String(call[1]?.body ?? "");
		// The cumulative proposed profile ships (aggregated from `proposed`).
		expect(body).toContain("profileMd");
		expect(body).toContain("Bold and direct.");
		// The operation INPUT (args) never reaches the Apply request: neither the
		// args envelope keys nor the canonical personality (which is only the
		// edit's `search` operand) appear in the serialized request.
		expect(body).not.toContain('"edits"');
		expect(body).not.toContain('"search"');
		expect(body).not.toContain("A reserved arachnid weaver.");
	});

	it("CA-12: 'select none' then Apply sends a canonical-body request (all changes reverted)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());

		const fetchMock = mock((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Click the "None" button (coauthor.review.select_none label).
		fireEvent.click(getByText("coauthor.review.select_none"));
		const boxes = container.querySelectorAll('[role="checkbox"]');
		expect([...boxes].every((b) => ariaChecked(b))).toBe(false);

		fireEvent.click(getByText("coauthor.review.apply"));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
		const body = String(call[1]?.body ?? "");
		// Everything reverted → canonical personality + scenario; none of the proposed.
		expect(body).toContain("A reserved arachnid weaver.");
		expect(body).toContain("A forest cave."); // canonical scenario (no "at dusk")
		expect(body).not.toContain("Bold and direct.");
		expect(body).not.toContain("A forest cave at dusk.");
	});

	// ── Bug repro: tool-result → store wire contract ───────────────────────────
	// The existing reviewing tests seed activities DIRECTLY into the turn store
	// (bypassing the SSE/safeParse path). This pins the wire-shape zazer: the
	// backend tool execute() returns {target, proposed, summary}; drainStream
	// JSON.stringifies it into the `tool-result` SSE `output`; the frontend
	// safeParses it back. A drift here (extra wrapper, renamed field) →
	// safeParse fails → status:"error" → no proposal → EMPTY reviewing panel —
	// the exact "diffs not showing" symptom. NOTE: this is a static contract
	// check; it cannot reproduce a runtime failure (SSE not arriving, store
	// cleared, isSending stuck). For those, a live Playwright repro is needed.

	it("wire contract: write_profile execute() output survives JSON round-trip through coauthorToolOutputSchema", () => {
		// Mirrors the real execute() return in coauthor-tools.ts.
		const output = {
			target: "profile",
			proposed: [
				"---", "name: Kira", "tags: []", "---", "",
				"# PERSONALITY", "Bold and direct.", "",
				"# SCENARIO", "A forest cave.", "",
				"# EXAMPLES", "{{char}}: *tilts head*", "",
			].join("\n"),
			summary: "Made personality bold.",
		};
		// The SSE serialize path: JSON.stringify in drainStream, JSON.parse in sse-parser.
		const roundTripped = JSON.parse(JSON.stringify(output));
		const parsed = coauthorToolOutputSchema.safeParse(roundTripped);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.target).toBe("profile");
			expect(parsed.data.proposed).toBe(output.proposed);
			expect(parsed.data.summary).toBe(output.summary);
		}
	});

	// ── Bug repro: character version folder-swap does not refresh the form ──────
	// PROVEN DEFECT (static analysis): CoauthorCharacterForm is mounted with
	// key={character.id}; a version folder-swap keeps the SAME id, so
	// CoauthorCharacterFormInner does NOT remount. useForm takes defaultValues
	// only on mount, and form.reset is called ONLY in handleSave/handleApply —
	// there is no [character] sync effect. The editor CM6 (initialBody on mount)
	// and the reviewing `diff` useMemo (deps [reviewing, proposal], no character)
	// likewise go stale. Symptom: after switching a character version, the
	// reviewing overlay diffs against the STALE canonical → wrong/empty panel.
	//
	// Repro (no LLM needed): the diff canonical comes from
	// draftToBody(form.getValues()). Seed v1 (description OLD) + a proposal
	// (description NEW) → 1 hunk. Then folder-swap to v2 whose description
	// already equals the proposal (description NEW) → diff should be EMPTY
	// (0 hunks). BUG: the form still holds v1 → the stale diff shows 1 hunk.

	it.failing("version folder-swap: reviewing canonical refreshes when character changes without remount", () => {
		__isSending = false;
		// v1 — canonical when reviewing begins.
		const v1 = seedReviewing({ description: "OLD personality." });
		// proposed description = NEW; greetings/scenario/examples match canonical defaults.
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "NEW personality."));
		const { container, rerender } = render(<CoauthorCharacterForm />);
		// v1 (OLD) vs proposed (NEW) → exactly 1 hunk (personality changed).
		expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);

		// Simulate a version folder-swap: SAME character id, NEW canonical content
		// (description now equals the proposal). key={character.id} is unchanged →
		// the inner form does NOT remount → it must sync via an effect (the defect).
		useSnapshotStore.setState({
			character: makeCharacter({ id: v1.id, description: "NEW personality." }),
		});
		rerender(<CoauthorCharacterForm />);

		// v2 (NEW) vs proposed (NEW) → 0 hunks (no visible changes).
		// BUG: the form/diff are stale → the old 1-hunk diff persists.
		expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
	});
});
