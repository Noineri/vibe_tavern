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
 * Uses the REAL snapshot-store (setState + clear in afterEach) to avoid a
 * process-global mock.module leak; `useIsSending` is overridden via the
 * spread-real pattern (no other test file consumes it, so zero leak). CM6
 * mounting in happy-dom is graceful-skip (mirrors VibeMdView.test.tsx); the
 * header affordance text is the always-present primary assertion.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { AppCharacter } from "../../app-client.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";
import { coauthorToolOutputSchema } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
vi.mock("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// useCharacterController is not consumed by any other test file → safe to mock
// fully. Stub the save write-path so the test never hits the network.
// vi.hoisted: vi.mock is hoisted above this line, so a plain outer const would
// be uninitialized when the factory runs. Hoisting the binding alongside the
// mock keeps every test-body call site (`handleSaveCharacter`) identical.
const { handleSaveCharacter } = vi.hoisted(() => ({ handleSaveCharacter: vi.fn(() => Promise.resolve()) }));
vi.mock("../../hooks/use-character-controller.js", () => ({
	useCharacterController: () => ({ handleSaveCharacter, isSavingCharacter: false }),
}));

// CA-13: the lorebook picker (LinkBindingPopover) pulls in CustomTooltip,
// which needs a Radix TooltipProvider context irrelevant to the form's
// behaviours. Passthrough it, mirroring VibeMdView.test.tsx.
vi.mock("../shared/Tooltip.js", () => ({
	CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
	TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// The picker fetches the lorebook / persona / script lists on mount; stub
// them empty so the test never hits the network. CE-C1 generalized the
// picker from lorebook-only to all four entity kinds.
vi.mock("../../api/lorebook-api.js", () => ({
	listAllLorebooks: () => Promise.resolve([]),
}));
vi.mock("../../api/persona-api.js", () => ({
	listPersonas: () => Promise.resolve([]),
}));
vi.mock("../../api/script-api.js", () => ({
	listAllScripts: () => Promise.resolve([]),
}));

// CE-C2/C3: BoundResourcesField (rendered inside the form) reads + writes
// character lorebook/script bindings via app-client. Mock those binding
// functions to empty/no-op so the field renders without hitting the network.
// Spread the real module first (preserves every other app-client export,
// including the AppCharacter TYPE the form itself imports).
vi.mock("../../app-client.js", async (importOriginal) => {
	const realAppClient = await importOriginal() as typeof import("../../app-client.js");
	return {
		...realAppClient,
		listAllLorebooks: () => Promise.resolve([]),
		listCharacterLorebooks: () => Promise.resolve([]),
		listPersonaLorebooks: () => Promise.resolve([]),
		getLorebookLinks: () => Promise.resolve([]),
		setLorebookLinks: () => Promise.resolve([]),
		listAllScripts: () => Promise.resolve([]),
		listCharacterScripts: () => Promise.resolve([]),
		listPersonaScripts: () => Promise.resolve([]),
		getScriptLinks: () => Promise.resolve([]),
		setScriptLinks: () => Promise.resolve([]),
	};
});

// chat-store: spread the REAL module first (preserves every other export for
// any co-running test file), override ONLY useIsSending with a controllable
// value. See AGENTS.md mock.module gotcha. Under vitest `vi.mock` is hoisted
// above `await import`, so `realChatStore` would resolve to the MOCKED module
// (useless); `importOriginal` bypasses the mock to read the real exports.
// `__isSending` is a plain `let` declared above the (lexically lower) mock so
// its closure binding is initialized by the time the lazily-invoked factory
// runs; tests mutate it directly and the `useIsSending` closure reads the
// live value on every render.
let __isSending = false;
vi.mock("../../stores/chat-store.js", async (importOriginal) => {
	const realChatStore = await importOriginal() as typeof import("../../stores/chat-store.js");
	return {
		...realChatStore,
		useIsSending: () => __isSending,
	};
});

function makeCharacter(over: Partial<AppCharacter> = {}): AppCharacter {
	return {
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

	beforeEach(() => {
		globalThis.fetch = realFetch;
		toast.warning = realToastWarning;
	});

	afterEach(() => {
		__isSending = false;
		globalThis.fetch = realFetch;
		toast.warning = realToastWarning;
		// Restore the real stores to their defaults so the in-process state does
		// not leak a test character / turn into other files.
		useSnapshotStore.getState().clear();
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
		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Saved subtitle (i18n key returned verbatim by the mock).
		expect(getByText("saved_state")).toBeTruthy();
		// Lock affordance is NOT shown while idle.
		expect(() => getByText("coauthor.editor.locked")).toThrow();
		// Editable (graceful skip if CM did not mount).
		const editable = cmEditable(container);
		if (editable !== null) expect(editable).not.toBe("false");
	});

	it("generating (isSending): editor locks and the 'AI is editing…' affordance shows", () => {
		__isSending = true;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Lock affordance (i18n key returned verbatim by the mock).
		expect(getByText("coauthor.editor.locked")).toBeTruthy();
		// Locked (graceful skip if CM did not mount).
		const editable = cmEditable(container);
		if (editable !== null) expect(editable).toBe("false");
	});

	it("locks when a generation starts mid-session (reconfigure effect)", () => {
		// Mount idle, then flip isSending and re-render — exercises the lock
		// EFFECT (Compartment reconfigure), not just the initial facet value.
		__isSending = false;
		useSnapshotStore.setState({ character: makeCharacter() });
		const { container, rerender, getByText } = render(<CoauthorCharacterForm />);
		expect(() => getByText("coauthor.editor.locked")).toThrow();

		__isSending = true;
		rerender(<CoauthorCharacterForm />);
		expect(getByText("coauthor.editor.locked")).toBeTruthy();
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
			activeChat: { id: TEST_CHAT, coauthorContextLinks: [{ targetType: "character", targetId: "char_pinned" }] } as never,
		});
		const { getByText } = render(<CoauthorCharacterForm />);
		expect(getByText("Mira")).toBeTruthy();
	});

	it("CE-C2/C3: context-level captions render so the L1/L2/L3 distinction is obvious", async () => {
		// The three levels each carry a caption stating what the model sees:
		// L1 full content, L2 lorebook names+titles, L3 script names+summaries.
		useSnapshotStore.setState({
			character: makeCharacter(),
			activeChat: { id: TEST_CHAT } as never,
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
		useSnapshotStore.setState({ character, activeChat: { id: TEST_CHAT } as never });
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

		const fetchMock = vi.fn((_url: unknown, _init: unknown) =>
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

		const warningSpy = vi.fn(() => {});
		toast.warning = warningSpy as never;

		globalThis.fetch = vi.fn((_u: unknown, _i: unknown) =>
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

		const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
		globalThis.fetch = fetchMock as never;

		const { getByText } = render(<CoauthorCharacterForm />);
		fireEvent.click(getByText("coauthor.review.reject"));

		// No RPC fired — Reject is local-only (discards the in-turn proposal).
		expect(fetchMock).not.toHaveBeenCalled();
		// Turn store cleared → idle.
		expect(useCoauthorTurnStore.getState().getActivities(TEST_CHAT)).toEqual([]);
	});

	// ── CTX-L3: lore proposal reviewing + Apply / Reject ───────────────────────
	// A lore-only turn (no profile/greeting) must still enter Reviewing, render the
	// structured lore surface, and commit the user's per-item selection via Apply.
	// Parent-dependency is enforced at the Apply boundary: deselecting a lorebook
	// drops its entries from the shipped bundle (selectLoreBundle).

	function makeLoreActivity(): CoauthorToolActivity {
		return {
			toolCallId: "l1",
			toolName: "create_lore_entry",
			status: "done",
			summary: "Drafted lore.",
			loreBundle: {
				lorebooks: [
					{ id: "lb1", name: "World Lore", description: "", scopeType: "global", enabled: true },
					{ id: "lb2", name: "Char Lore", description: "", scopeType: "character", enabled: true },
				],
				entries: [
					{ id: "e1", lorebookId: "lb1", title: "Eldoria", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
					{ id: "e2", lorebookId: "lb2", title: "Vex", content: "c2", keys: ["k2"], secondaryKeys: [], constant: true, position: "before_char", depth: 4, enabled: true },
				],
			},
		};
	}

	it("CTX-L3: a lore-only turn enters Reviewing and Apply ships the wholesale loreBundle (no profileMd)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
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

	it("CTX-L3: Apply with a deselected lorebook drops its entries (parent-dependency at the Apply boundary)", async () => {
		__isSending = false;
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeLoreActivity());

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
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

		const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
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
		const boxes = container.querySelectorAll('input[type="checkbox"]');
		// Two hunks (personality + scenario); greetings untouched → no greeting hunk.
		expect(boxes.length).toBe(2);
		expect([...boxes].every((b) => (b as HTMLInputElement).checked)).toBe(true); // all on (wholesale default)
	});

	it("CA-12: toggling a hunk off + Apply sends a PARTIAL request (rejected hunk reverts to canonical)", async () => {
		__isSending = false;
		// Canonical personality: "A reserved arachnid weaver."; scenario: "A forest cave."
		seedReviewing();
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, twoHunkProfileActivity());

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ character: makeCharacter({ description: "A reserved arachnid weaver.", scenario: "A forest cave at dusk." }), corrections: [] }),
				text: async () => "",
			}),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		const boxes = container.querySelectorAll('input[type="checkbox"]');
		expect(boxes.length).toBe(2);
		// Deselect the FIRST hunk (personality) — keep the scenario hunk accepted.
		fireEvent.click(boxes[0]!);
		expect((boxes[0]! as HTMLInputElement).checked).toBe(false);
		expect((boxes[1]! as HTMLInputElement).checked).toBe(true);

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

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
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

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter({ description: "Bold and direct." }), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Reviewing entered; exactly one hunk (personality changed; scenario/examples match canonical).
		expect(getByText("coauthor.review.state")).toBeTruthy();
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

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

		const fetchMock = vi.fn((_u: unknown, _i: unknown) =>
			Promise.resolve({ ok: true, status: 200, json: async () => ({ character: makeCharacter(), corrections: [] }), text: async () => "" }),
		);
		globalThis.fetch = fetchMock as never;

		const { container, getByText } = render(<CoauthorCharacterForm />);
		// Click the "None" button (coauthor.review.select_none label).
		fireEvent.click(getByText("coauthor.review.select_none"));
		const boxes = container.querySelectorAll('input[type="checkbox"]');
		expect([...boxes].every((b) => (b as HTMLInputElement).checked)).toBe(false);

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

	it.fails("version folder-swap: reviewing canonical refreshes when character changes without remount", () => {
		__isSending = false;
		// v1 — canonical when reviewing begins.
		const v1 = seedReviewing({ description: "OLD personality." });
		// proposed description = NEW; greetings/scenario/examples match canonical defaults.
		useCoauthorTurnStore.getState().upsertActivity(TEST_CHAT, makeProfileActivity("t1", "NEW personality."));
		const { container, rerender } = render(<CoauthorCharacterForm />);
		// v1 (OLD) vs proposed (NEW) → exactly 1 hunk (personality changed).
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

		// Simulate a version folder-swap: SAME character id, NEW canonical content
		// (description now equals the proposal). key={character.id} is unchanged →
		// the inner form does NOT remount → it must sync via an effect (the defect).
		useSnapshotStore.setState({
			character: makeCharacter({ id: v1.id, description: "NEW personality." }),
		});
		rerender(<CoauthorCharacterForm />);

		// v2 (NEW) vs proposed (NEW) → 0 hunks (no visible changes).
		// BUG: the form/diff are stale → the old 1-hunk diff persists.
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
	});
});
