/**
 * computePersonaIsDirty — dirty-state check for the controlled persona form.
 *
 * Regression coverage for F10 ("Save stays disabled while editing"): the form
 * is fully controlled (value={watch} + onChange=setValue, no `register`), so
 * react-hook-form's `formState.isDirty` doesn't reliably flip true on edits.
 * The fix snapshots the values the form was reset to (seedForm / create-new)
 * and compares the live values against it via this pure helper.
 *
 * These tests pin the comparison logic itself (no DOM / RHF internals). The
 * end-to-end wiring (form.watch() feeding `current`, baselineRef set on reset)
 * is exercised by the render path; the logic contract is what's guarded here.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// Network stub: the detail editor mounts BoundResourcesField, which lists
// available/bound lorebooks + scripts on mount. Stub those four reads at the
// app-client boundary (gallery-store.test.ts idiom: capture reals, spread
// first, override only the specific fns); everything else stays real.
const realAppClient = await import("../../app-client.js");
mock.module("../../app-client.js", () => ({
	...realAppClient,
	listAllLorebooks: async () => [],
	listPersonaLorebooks: async () => [],
	listAllScripts: async () => [],
	listPersonaScripts: async () => [],
}));

const [
	{ createElement },
	{ act, fireEvent, render },
	{ useModalStore },
	{ TooltipProvider },
	{ computePersonaIsDirty, PersonaModal },
] = await Promise.all([
	import("react"),
	import("@testing-library/react"),
	import("../../stores/modal-store.js"),
	import("../shared/Tooltip.js"),
	import("./PersonaModal.js"),
]);

const baseline = {
	name: "Noi",
	description: "A persona",
	pronouns: "they/them" as string | null,
	pfSubjective: "",
	pfObjective: "",
	pfPossessive: "",
	pfPossessivePronoun: "",
	pfReflexive: "",
	avatarAssetId: null,
	avatarFullAssetId: null,
	avatarCropJson: null,
	avatarPreview: null,
};

afterEach(() => {
	useModalStore.setState({ isPersonaModalOpen: false });
});

describe("PersonaModal render lifecycle", () => {
	test("opens after being mounted closed without changing its hook order", () => {
		useModalStore.setState({ isPersonaModalOpen: false });
		const props = {
			personas: [],
			activePersonaId: null,
			isSaving: false,
			onSaveEdit: () => {},
			onSetActive: () => {},
			onCreatePersona: async () => null,
			onDuplicatePersona: async () => {},
			onDeletePersona: async () => ({ ok: true }),
			onSetDefaultPersona: async () => {},
		};
		const view = render(createElement(TooltipProvider, null,
			createElement(PersonaModal, props),
		));

		expect(view.queryByText("persona_manager_title")).toBeNull();
		act(() => useModalStore.getState().setIsPersonaModalOpen(true));
		expect(view.getByText("persona_manager_title")).toBeTruthy();
	});
});

describe("PersonaModal master-detail wiring", () => {
	const fixtures = [
		{
			id: "p1",
			name: "Alice",
			description: "First persona",
			pronouns: "she/her" as string | null,
			pronounForms: null,
			avatarAssetId: null,
			avatarExt: null,
			avatarCropJson: null,
			defaultForNewChats: true,
			includeAvatarInPrompt: false,
			avatarDescription: null,
			updatedAt: "2026-09-07T00:00:00.000Z",
		},
		{
			id: "p2",
			name: "Bob",
			description: "Second persona",
			pronouns: null,
			pronounForms: null,
			avatarAssetId: null,
			avatarExt: null,
			avatarCropJson: null,
			defaultForNewChats: false,
			includeAvatarInPrompt: false,
			avatarDescription: null,
			updatedAt: "2026-09-07T00:00:00.000Z",
		},
	];

	type Draft = { name: string; description: string };
	type Calls = { setActive: string[]; saveEdit: Array<{ id: string; draft: Draft }> };

	function propsFor(calls: Calls, list = fixtures, activeId: string | null = "p1") {
		return {
			personas: list,
			activePersonaId: activeId,
			isSaving: false,
			onSaveEdit: (id: string, draft: Draft) => { calls.saveEdit.push({ id, draft: { name: draft.name, description: draft.description } }); },
			onSetActive: (id: string) => { calls.setActive.push(id); },
			onCreatePersona: async () => null,
			onDuplicatePersona: async () => {},
			onDeletePersona: async () => ({ ok: true }),
			onSetDefaultPersona: async () => {},
		};
	}

	function renderOpen(calls: Calls, list = fixtures, activeId: string | null = "p1") {
		useModalStore.setState({ isPersonaModalOpen: true });
		return render(createElement(TooltipProvider, null,
			createElement(PersonaModal, propsFor(calls, list, activeId)),
		));
	}

	// Drain the mocked lorebook/script loads (BoundResourcesField refreshes on
	// mount) so their setStates land inside act instead of warning.
	async function settled() {
		await act(async () => {});
	}

	test("opening the modal seeds the editor with the active persona (no blank detail pane)", async () => {
		useModalStore.setState({ isPersonaModalOpen: false });
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = render(createElement(TooltipProvider, null,
			createElement(PersonaModal, propsFor(calls)),
		));
		act(() => useModalStore.getState().setIsPersonaModalOpen(true));
		await settled();
		expect((view.getByPlaceholderText("persona_name_placeholder") as HTMLInputElement).value).toBe("Alice");
	});

	test("row click activates the persona and seeds the detail editor", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = renderOpen(calls);
		await settled();
		fireEvent.click(view.getByText("Bob"));
		await settled();
		expect(calls.setActive).toEqual(["p2"]);
		expect((view.getByPlaceholderText("persona_name_placeholder") as HTMLInputElement).value).toBe("Bob");
	});

	test("footer Save commits the seeded draft via onSaveEdit", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = renderOpen(calls);
		await settled();
		fireEvent.click(view.getByText("Bob"));
		await settled();
		const nameInput = view.getByPlaceholderText("persona_name_placeholder") as HTMLInputElement;
		fireEvent.change(nameInput, { target: { value: "Bobby" } });
		fireEvent.click(view.getByText("save_btn"));
		expect(calls.saveEdit.length).toBe(1);
		expect(calls.saveEdit[0].id).toBe("p2");
		expect(calls.saveEdit[0].draft.name).toBe("Bobby");
		expect(calls.saveEdit[0].draft.description).toBe("Second persona");
	});

	test("footer shows Duplicate/Export/Delete for the selected persona; Delete omitted for the last persona", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = renderOpen(calls);
		await settled();
		view.getByText("duplicate");
		view.getByText("persona_export");
		view.getByText("delete");
		view.unmount();
		const singleCalls: Calls = { setActive: [], saveEdit: [] };
		const single = renderOpen(singleCalls, [fixtures[0]], "p1");
		await settled();
		single.getByText("duplicate");
		single.getByText("persona_export");
		expect(single.queryByText("delete")).toBeNull();
	});
});

describe("computePersonaIsDirty", () => {
	test("returns false when there is no baseline yet (form never reset)", () => {
		// Before seedForm / create-new, baselineRef.current is null → not dirty,
		// so Save stays disabled (no prior state to compare against).
		expect(computePersonaIsDirty(baseline, null)).toBe(false);
	});

	test("returns false when current values equal the baseline (pristine)", () => {
		// Right after seedForm: form was just reset, nothing edited yet.
		expect(computePersonaIsDirty({ ...baseline }, baseline)).toBe(false);
	});

	test("returns true when name was edited (the reported F10 repro)", () => {
		// The exact reported bug: editing name must flip Save enabled.
		expect(computePersonaIsDirty({ ...baseline, name: "Noi edited" }, baseline)).toBe(true);
	});

	test("returns true when description was edited", () => {
		expect(computePersonaIsDirty({ ...baseline, description: "changed" }, baseline)).toBe(true);
	});

	test("returns true when pronouns were edited", () => {
		expect(computePersonaIsDirty({ ...baseline, pronouns: "she/her" }, baseline)).toBe(true);
	});

	test("returns true when an avatar field was edited (async avatar crop)", () => {
		// Avatar edits arrive via setValue after seedForm; they must count.
		expect(computePersonaIsDirty({ ...baseline, avatarAssetId: "ast_new" }, baseline)).toBe(true);
		expect(computePersonaIsDirty({ ...baseline, avatarPreview: "data:..." }, baseline)).toBe(true);
	});

	test("returns false when current is null/undefined regardless of baseline", () => {
		expect(computePersonaIsDirty(null, baseline)).toBe(false);
		expect(computePersonaIsDirty(undefined, baseline)).toBe(false);
	});
});
