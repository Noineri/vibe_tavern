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
import { describe, it, expect, mock, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";
import type { AppCharacter } from "../../app-client.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";

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

	afterEach(() => {
		__isSending = false;
		// Restore the real snapshot-store to its default (no character) so the
		// in-process store does not leak a test character into other files.
		useSnapshotStore.getState().clear();
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
});
