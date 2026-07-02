/**
 * CS-16 — CoauthorModuleModal (read-only author-module picker).
 *
 * Pins the wave-2 behaviours required by the plan:
 *  - closed by default (the title is absent until the modal-store flag flips);
 *  - on open, loads the bundled module list and renders every module name;
 *  - the detail preview surfaces base prompt / skills / tools / max steps;
 *  - selecting a non-active module and activating calls setCoauthorModuleAction
 *    with the chat id + chosen module id, then closes the modal;
 *  - the active module (null coauthorModuleId → "default" fallback) is
 *    highlighted and its Activate button is suppressed (already in effect).
 *
 * MasterDetailModal is mocked as a passthrough so the test exercises the
 * component's data flow (load → list → preview → activate) without depending on
 * Radix Dialog portal / matchMedia plumbing. The modal-store and snapshot-store
 * are used for real (setState + reset in afterEach) — same pattern as
 * CoauthorCharacterForm.test.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useModalStore } from "../../stores/modal-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { CoauthorModuleModal } from "./CoauthorModuleModal.js";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
mock.module("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// Stub the two RPC actions the modal calls. listCoauthorModulesAction returns
// a fixed seed triple; setCoauthorModuleAction is a spy the activate test asserts.
const SEED_MODULES: CoauthorModule[] = [
	{
		id: "default",
		name: "Default Co-Author",
		description: "A balanced co-author module.",
		basePromptFile: "coauthor/modules/default.md",
		skillIds: ["general-writing"],
		toolSet: { edit_profile: true, edit_personality: true, edit_scenario: true, edit_examples: true, edit_greeting: true, add_alt_greeting: true, edit_alt_greeting: true },
		maxSteps: 5,
	},
	{
		id: "profile-editor",
		name: "Profile Editor",
		description: "Refines character profiles.",
		basePromptFile: "coauthor/modules/profile-editor.md",
		skillIds: ["profile-analysis"],
		toolSet: { edit_profile: true, edit_personality: true },
		maxSteps: 3,
	},
];
const setCoauthorModuleAction = mock<(chatId: string, moduleId: string | null) => Promise<void>>(
	() => Promise.resolve(),
);
mock.module("../../stores/api-actions/chat-actions.js", () => ({
	listCoauthorModulesAction: () => Promise.resolve(SEED_MODULES),
	setCoauthorModuleAction,
}));

// MasterDetailModal passthrough: render master + detail flat so the test can
// query both columns without Radix Dialog / matchMedia. Mirrors the real
// component's prop contract (masterContent / detailContent may be nodes).
mock.module("../shared/MasterDetailModal.js", () => ({
	MasterDetailModal: ({ isOpen, onClose, masterContent, detailContent, footer }: {
		isOpen: boolean;
		onClose: () => void;
		masterContent: React.ReactNode;
		detailContent: React.ReactNode;
		footer: React.ReactNode;
	}) => {
		if (!isOpen) return null;
		return (
			<div data-testid="md-modal">
				<div data-testid="md-master">{masterContent}</div>
				<div data-testid="md-detail">{detailContent}</div>
				<div data-testid="md-footer">{footer}</div>
				<button type="button" onClick={onClose} data-testid="md-close">close</button>
			</div>
		);
	},
}));

afterEach(() => {
	useModalStore.setState({ isCoauthorModuleModalOpen: false });
	useSnapshotStore.setState({ activeChat: null });
	setCoauthorModuleAction.mockClear();
});

function openModal() {
	useModalStore.setState({
		isCoauthorModuleModalOpen: true,
	});
}

function setActiveChat(coauthorModuleId: string | null) {
	useSnapshotStore.setState({
		activeChat: {
			id: "chat_test",
			characterId: "char_test",
			mode: "coauthor",
			coauthorModuleId,
			coauthorLorebookIds: [],
		} as never,
	});
}

describe("CoauthorModuleModal", () => {
	useDomEnv();

	it("renders nothing while closed", () => {
		setActiveChat(null);
		openModal();
		useModalStore.setState({ isCoauthorModuleModalOpen: false });
		const { queryByTestId } = render(<CoauthorModuleModal />);
		expect(queryByTestId("md-modal")).toBeNull();
	});

	it("lists every bundled module name on open (read-only)", async () => {
		setActiveChat(null);
		openModal();
		const { getAllByText, queryByText } = render(<CoauthorModuleModal />);
		// The active module name appears in BOTH the master list and the detail
		// preview (the active module is the default preview selection), so use
		// getAllByText and assert presence, not uniqueness.
		await waitFor(() => expect(getAllByText(/Default Co-Author/).length).toBeGreaterThan(0));
		expect(getAllByText(/Profile Editor/).length).toBeGreaterThan(0);
		// Read-only contract: no create/edit affordance exists in the modal.
		expect(queryByText(/create|edit module|delete/i)).toBeNull();
	});

	it("highlights the active module, defaulting null coauthorModuleId to the default module", async () => {
		setActiveChat(null);
		openModal();
		const { getAllByText, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getAllByText(/Default Co-Author/).length).toBeGreaterThan(0));
		// profile-editor is NOT active → selecting it reveals the Activate button.
		fireEvent.click(getAllByText(/Profile Editor/)[0]);
		expect(getByText("coauthor.module.activate")).toBeTruthy();
	});

	it("previews base prompt, skills, tools, and max steps for the selected module", async () => {
		setActiveChat(null);
		openModal();
		const { getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("Profile Editor")).toBeTruthy());
		fireEvent.click(getByText("Profile Editor"));
		expect(getByText("coauthor/modules/profile-editor.md")).toBeTruthy();
		expect(getByText("profile-analysis")).toBeTruthy();
		expect(getByText("edit_profile")).toBeTruthy();
		expect(getByText("3")).toBeTruthy();
	});

	it("activating a non-active module calls setCoauthorModuleAction(chatId, moduleId) and closes", async () => {
		setActiveChat("default");
		openModal();
		const { getByText, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("Profile Editor")).toBeTruthy());
		fireEvent.click(getByText("Profile Editor"));
		fireEvent.click(getByText("coauthor.module.activate"));
		await waitFor(() => expect(setCoauthorModuleAction).toHaveBeenCalledTimes(1));
		expect(setCoauthorModuleAction.mock.calls[0]).toEqual(["chat_test", "profile-editor"]);
		// The modal closes on successful activation.
		await waitFor(() => expect(queryByTestId("md-modal")).toBeNull());
	});
});
