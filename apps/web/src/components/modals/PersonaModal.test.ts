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
import type { PersonaListItem } from "./PersonaModal.js";

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
			avatarFullAssetId: null,
			avatarFullExt: null,
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
			avatarFullAssetId: null,
			avatarFullExt: null,
			avatarCropJson: null,
			defaultForNewChats: false,
			includeAvatarInPrompt: false,
			avatarDescription: null,
			updatedAt: "2026-09-07T00:00:00.000Z",
		},
	];

	type Draft = { name: string; description: string };
	type Calls = { setActive: string[]; saveEdit: Array<{ id: string; draft: Draft }> };

	function propsFor(calls: Calls, list: PersonaListItem[] = fixtures, activeId: string | null = "p1") {
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

	function renderOpen(calls: Calls, list: PersonaListItem[] = fixtures, activeId: string | null = "p1") {
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

	test("row click selects for editing only; the row button activates", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = renderOpen(calls);
		await settled();
		fireEvent.click(view.getByText("Bob"));
		await settled();
		// Wave 4: the row itself no longer mutates the active persona — it only
		// seeds the detail editor. Activation is explicit via the row button
		// (ProviderViewHeader make-active pattern).
		expect(calls.setActive).toEqual([]);
		expect((view.getByPlaceholderText("persona_name_placeholder") as HTMLInputElement).value).toBe("Bob");
		fireEvent.click(view.getByText("persona_use_for_chat"));
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


	test("editor avatar block mirrors the character card (D-1): veil + thumbnail crop, no delete x, opens cropper on the full endpoint", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		// p1 gets a folder-resident avatar so the editor renders the avatar
		// branch (placeholder otherwise). editDisplayAvatar resolves preferFull,
		// so the editor frame must show /avatar/full. NOTE: the modal portals to
		// document.body, so raw DOM queries must run against document (RTL
		// query helpers are already baseElement-bound).
		const withAvatar = fixtures.map((p, i) => (i === 0 ? { ...p, avatarExt: "png" } : p));
		const view = renderOpen(calls, withAvatar);
		await settled();
		// The editor avatar frame = the dashed frame containing the full img.
		// (The master list's "+ New" block is the other dashed frame.)
		const editorFrame = Array.from(document.querySelectorAll('div[class*="border-dashed"]')).find(f => f.querySelector('img[src*="/avatar/full"]'));
		expect(editorFrame).toBeTruthy();
		// Hover veil (black/50 + pencil) - character-card parity.
		expect(editorFrame!.querySelector('div[class*="bg-black/50"]')).toBeTruthy();
		// Corner "edit thumbnail" button (always visible, not hover-only).
		const cropBtn = editorFrame!.querySelector('button[class*="bottom-1.5"]');
		expect(cropBtn).toBeTruthy();
		// The un-flagged x delete affordance is gone (owner ruling: the
		// character card has no avatar deletion either).
		expect(editorFrame!.querySelector('button[class*="hover:text-danger"]')).toBeNull();
		// Clicking the corner button opens the cropper on the EXISTING avatar
		// via the full endpoint (re-frame the thumbnail without re-uploading).
		fireEvent.click(cropBtn!);
		await settled();
		expect(view.getByText("crop_avatar_title")).toBeTruthy();
		expect(document.querySelector('img[src*="/avatar/full"]')).toBeTruthy();
	});

	test("editor section order: bound lorebooks directly under the name row, before the description (D-3)", async () => {
		const calls: Calls = { setActive: [], saveEdit: [] };
		const view = renderOpen(calls);
		await settled();
		// D-3: the character-card order is name -> resources -> description.
		// The modal portals to document.body; compare DOM positions there
		// (the description is a textarea whose label is an attribute, not text).
		const pronounEl = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "they/them");
		const boundEl = Array.from(document.querySelectorAll("span")).find(s => s.textContent === "bound_lorebooks_label");
		const descEl = document.querySelector('textarea[placeholder="persona_desc_placeholder"]');
		expect(pronounEl).toBeTruthy();
		expect(boundEl).toBeTruthy();
		expect(descEl).toBeTruthy();
		expect(boundEl!.compareDocumentPosition(pronounEl!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
		expect(boundEl!.compareDocumentPosition(descEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
