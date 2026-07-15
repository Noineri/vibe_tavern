/**
 * computePersonaIsDirty — dirty-state check for the controlled persona form.
 *
 * Regression coverage for F10 ("Save stays disabled while editing"): the form
 * is fully controlled (value={watch} + onChange=setValue, no `register`), so
 * react-hook-form's `formState.isDirty` doesn't reliably flip true on edits.
 * The fix snapshots the values the form was reset to (startEdit / create-new)
 * and compares the live values against it via this pure helper.
 *
 * These tests pin the comparison logic itself (no DOM / RHF internals). The
 * end-to-end wiring (form.watch() feeding `current`, baselineRef set on reset)
 * is exercised by the render path; the logic contract is what's guarded here.
 */
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useModalStore } from "../../stores/modal-store.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import { computePersonaIsDirty, PersonaModal } from "./PersonaModal.js";

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
		const view = render(createElement(TooltipProvider, null,
			createElement(PersonaModal, {
				personas: [],
				activePersonaId: null,
				isSaving: false,
				onSaveEdit: () => {},
				onSetActive: () => {},
				onCreatePersona: async () => null,
				onDuplicatePersona: async () => {},
				onDeletePersona: async () => ({ ok: true }),
				onSetDefaultPersona: async () => {},
			}),
		));

		expect(view.queryByText("persona_manager_title")).toBeNull();
		act(() => useModalStore.getState().setIsPersonaModalOpen(true));
		expect(view.getByText("persona_manager_title")).toBeTruthy();
	});
});

describe("computePersonaIsDirty", () => {
	test("returns false when there is no baseline yet (form never reset)", () => {
		// Before startEdit / create-new, baselineRef.current is null → not dirty,
		// so Save stays disabled (no prior state to compare against).
		expect(computePersonaIsDirty(baseline, null)).toBe(false);
	});

	test("returns false when current values equal the baseline (pristine)", () => {
		// Right after startEdit: form was just reset, nothing edited yet.
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
		// Avatar edits arrive via setValue after startEdit; they must count.
		expect(computePersonaIsDirty({ ...baseline, avatarAssetId: "ast_new" }, baseline)).toBe(true);
		expect(computePersonaIsDirty({ ...baseline, avatarPreview: "data:..." }, baseline)).toBe(true);
	});

	test("returns false when current is null/undefined regardless of baseline", () => {
		expect(computePersonaIsDirty(null, baseline)).toBe(false);
		expect(computePersonaIsDirty(undefined, baseline)).toBe(false);
	});
});
