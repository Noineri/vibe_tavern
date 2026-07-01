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
import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { AppCharacter } from "../../app-client.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";
import { toast } from "sonner";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
mock.module("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// useCharacterController is not consumed by any other test file → safe to mock
// fully. Stub the save write-path so the test never hits the network.
const handleSaveCharacter = mock(() => Promise.resolve());
mock.module("../../hooks/use-character-controller.js", () => ({
	useCharacterController: () => ({ handleSaveCharacter, isSavingCharacter: false }),
}));

// chat-store: spread the REAL module first (preserves every other export for
// any co-running test file), override ONLY useIsSending with a controllable
// value. See AGENTS.md mock.module gotcha.
let __isSending = false;
const realChatStore = await import("../../stores/chat-store.js");
mock.module("../../stores/chat-store.js", () => ({
	...realChatStore,
	useIsSending: () => __isSending,
}));

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
	useDomEnv();

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
		return { toolCallId, toolName: "edit_profile", status: "done", target: "profile", proposed, summary };
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
			{ toolCallId: "t1", toolName: "edit_profile", status: "streaming" },
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
});
