/**
 * The provider format pane (LS-10, owner redesign 2026-09-09 audit 3): a 1:1
 * sampler-set clone — ONE accordion whose header carries the template row
 * (backend-first dropdown + icon actions + morph rename + confirm delete) and
 * the manual toggle switch. Body order: collapsible PREVIEW sub-accordion
 * FIRST, then the sequence fields (greyed while the toggle is off), then the
 * LS-9 empty-stops hint. The status line lives under the accordion.
 *
 * The RPC client seam is mocked at the module boundary (T2: the format-
 * template library is a true external boundary — apps/web's per-file process
 * makes the mock.module leak structurally impossible here).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { FormState } from "../../modals/ProviderModal.js";
import type { ProviderGenerationFormat } from "@vibe-tavern/domain";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (key: string, vars?: Record<string, string>) => {
			let text: string = key;
			if (vars) {
				for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
			}
			return text;
		},
	}),
}));

const realFormatApi = await import("../../../api/format-template-api.js");

// The canon tooltip needs a provider in tests — the established panel-test
// pattern renders children bare (ProviderSamplerPanel.test.tsx).
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
	TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

type StoredTemplate = { id: string; name: string; payload: Record<string, unknown> };

const templates: StoredTemplate[] = [];
const updateCalls: Array<{ id: string; patch: { name?: string; payload?: Record<string, unknown> } }> = [];
const deleteCalls: string[] = [];

const materialize = (tpl: StoredTemplate, index: number) => ({
	id: tpl.id,
	name: tpl.name,
	sortOrder: index,
	payload: tpl.payload,
	createdAt: "2026-09-09",
	updatedAt: "2026-09-09",
});

mock.module("../../../api/format-template-api.js", () => ({
	...realFormatApi,
	listFormatTemplates: async () => templates.map(materialize),
	createFormatTemplate: async (input: { name: string; payload: Record<string, unknown> }) => {
		const tpl = { id: `ftpl_${templates.length + 1}`, name: input.name, payload: input.payload };
		templates.push(tpl);
		return materialize(tpl, templates.length - 1);
	},
	updateFormatTemplate: async (id: string, patch: { name?: string; payload?: Record<string, unknown> }) => {
		updateCalls.push({ id, patch });
		const tpl = templates.find((entry) => entry.id === id);
		if (!tpl) throw new Error("not found");
		if (patch.name !== undefined) tpl.name = patch.name;
		if (patch.payload !== undefined) tpl.payload = patch.payload;
		return materialize(tpl, templates.indexOf(tpl));
	},
	deleteFormatTemplate: async (id: string) => {
		deleteCalls.push(id);
		const index = templates.findIndex((entry) => entry.id === id);
		if (index >= 0) templates.splice(index, 1);
	},
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
});

const { ProviderFormatPanel } = await import("./ProviderFormatPanel.js");

function makeForm(over: Partial<FormState> = {}): FormState {
	return {
		stopSequences: [],
		generationFormat: null,
		...over,
	} as FormState;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The last generationFormat update pushed through updateForm. */
function lastStored(updates: Array<{ k: string; v: unknown }>): ProviderGenerationFormat | undefined {
	return (updates.filter((u) => u.k === "generationFormat").at(-1) as { v: ProviderGenerationFormat } | undefined)?.v;
}

describe("ProviderFormatPanel (sampler-clone redesign)", () => {
	beforeEach(() => {
		templates.length = 0;
		updateCalls.length = 0;
		deleteCalls.length = 0;
	});

	it("renders the single accordion with the header template row + manual toggle; status and fallback note live UNDER it", () => {
		const { getByTestId, getByText, queryByTestId } = render(
			<ProviderFormatPanel form={makeForm()} updateForm={mock()} tcTemplateSource="default" />,
		);
		expect(getByTestId("provider-format-sequences-toggle")).toBeTruthy();
		// The header row: dropdown + the manual toggle (no SegmentedControl).
		expect(getByTestId("provider-format-template")).toBeTruthy();
		expect(getByTestId("provider-format-manual-toggle")).toBeTruthy();
		expect(getByText("providerFormat.formatTitle")).toBeTruthy();
		// Status + fallback note under the accordion (auto state).
		expect(getByText("providerFormat.statusDefault")).toBeTruthy();
		expect(getByText("providerFormat.fallbackNote")).toBeTruthy();
		// The mode segmented control is gone (owner audit 3).
		expect(queryByTestId("provider-format-mode")).toBeNull();
		// Body inert while collapsed (AnimatedDisclosure unmounts).
		expect(queryByTestId("provider-format-preview")).toBeNull();
		expect(queryByTestId("provider-format-stops-empty-hint")).toBeNull();
	});

	it("body order (owner audit 3): the collapsible preview sub-accordion comes FIRST, before the sequence inputs; collapsed by default", () => {
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "builtin:chatml", format: { mode: "manual", inputSequence: "User: " } },
		});
		const { getByTestId, queryByTestId } = render(<ProviderFormatPanel form={form} updateForm={mock()} tcTemplateSource="default" />);
		fireEvent.click(getByTestId("provider-format-sequences-toggle"));
		const preview = getByTestId("provider-format-preview");
		const firstField = getByTestId("provider-format-sequences").querySelector("input[type=text]")!;
		expect(firstField).toBeTruthy();
		// PREVIEW FIRST — it precedes the first sequence input in DOM order.
		expect(preview.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// Collapsible: collapsed by default (no body), opens on toggle.
		expect(queryByTestId("provider-format-preview-body")).toBeNull();
		fireEvent.click(getByTestId("provider-format-preview-toggle"));
		expect(getByTestId("provider-format-preview-body")).toBeTruthy();
		fireEvent.click(getByTestId("provider-format-preview-toggle"));
		// Closed again (aria pins the collapsed state; the exiting node lingers
		// only until framer-motion finishes its 250ms exit — not our boundary).
		expect(getByTestId("provider-format-preview-toggle").getAttribute("aria-expanded")).toBe("false");
	});

	it("toggle OFF = auto: the fields are greyed/inert; toggle ON seeds the fields from the selected template (sampler applySet analog)", () => {
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const autoForm = makeForm({ generationFormat: { mode: "auto", selection: "builtin:chatml" } });
		const view = render(<ProviderFormatPanel form={autoForm} updateForm={updateForm} tcTemplateSource="default" />);
		// Toggle ON: manual mode + seeded fields + the pointer rides along.
		fireEvent.click(view.getByTestId("provider-format-manual-toggle"));
		const on = lastStored(updates);
		expect(on?.mode).toBe("manual");
		expect(on?.selection).toBe("builtin:chatml");
		expect((on?.format?.inputSequence ?? "").includes("<|im_start|>")).toBe(true);
		// Re-render with the manual stored state: the fields are editable now.
		view.rerender(<ProviderFormatPanel form={makeForm({ generationFormat: on! })} updateForm={updateForm} tcTemplateSource="default" />);
		fireEvent.click(view.getByTestId("provider-format-sequences-toggle"));
		const fields = view.getByTestId("provider-format-sequences").querySelectorAll("input[type=text]");
		expect(fields.length).toBeGreaterThan(0);
		// Toggle OFF: auto again — pointer AND fields ride (off→on keeps both).
		fireEvent.click(view.getByTestId("provider-format-manual-toggle"));
		const off = lastStored(updates);
		expect(off?.mode).toBe("auto");
		expect(off?.selection).toBe("builtin:chatml");
		expect(off?.format?.inputSequence).toBe(on?.format?.inputSequence);
	});

	it("auto state: the sequence fields render greyed + inert (pointer-events-none)", () => {
		const form = makeForm({ generationFormat: { mode: "auto", selection: "builtin:chatml" } });
		const { getByTestId } = render(<ProviderFormatPanel form={form} updateForm={mock()} tcTemplateSource="default" />);
		fireEvent.click(getByTestId("provider-format-sequences-toggle"));
		const editable = getByTestId("provider-format-fields");
		expect(editable.className.includes("pointer-events-none")).toBe(true);
		expect(editable.className.includes("opacity-40")).toBe(true);
	});

	it("the dropdown is backend-first: backend option + builtins group; picking ChatML in manual writes its sequences and KEEPS manual mode", async () => {
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "backend", format: { mode: "manual", inputSequence: "User: " } },
		});
		const { getByTestId } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);
		fireEvent.click(getByTestId("provider-format-template"));
		await settle();
		const options = Array.from(document.querySelectorAll("[cmdk-item]"));
		// Backend IS an entry (the "no set" analog), builtins grouped, customs listed.
		expect(options.some((el) => el.textContent?.includes("providerFormat.templateBackend"))).toBe(true);
		const chatml = options.find((el) => el.textContent?.includes("ChatML"));
		expect(chatml).toBeTruthy();
		fireEvent.click(chatml!);
		await settle();
		const applied = lastStored(updates);
		expect(applied?.mode).toBe("manual");
		expect(applied?.selection).toBe("builtin:chatml");
		expect((applied?.format?.inputSequence ?? "").includes("<|im_start|>")).toBe(true);
	});

	it("dirty dot: diverged fields vs the selected template light it; 🔄 re-apply reseeds the fields", async () => {
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "builtin:chatml", format: { mode: "manual", inputSequence: "X: " } },
		});
		const { getByTestId, unmount } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);
		expect(getByTestId("provider-format-dirty-dot")).toBeTruthy();
		fireEvent.click(getByTestId("provider-format-template-reapply"));
		await settle();
		const reseeded = lastStored(updates);
		expect(reseeded?.mode).toBe("manual");
		expect((reseeded?.format?.inputSequence ?? "").includes("<|im_start|>")).toBe(true);
		// With the reseeded stored state the divergence (and the dot) is gone.
		// (Unmount the first view — RTL queries search the whole body.)
		unmount();
		const view2 = render(
			<ProviderFormatPanel form={makeForm({ generationFormat: reseeded! })} updateForm={updateForm} tcTemplateSource="default" />,
		);
		expect(view2.queryByTestId("provider-format-dirty-dot")).toBeNull();
	});

	it("+ create-from-fields morph: name input, collision warning on a taken name, success applies the created custom (pointer + clean baseline)", async () => {
		templates.push({ id: "ftpl_x", name: "Taken", payload: { mode: "manual" } });
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "backend", format: { mode: "manual", inputSequence: "<u> " } },
		});
		const { getByTestId, queryByTestId } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);
		await settle(); // the library loads via a useEffect promise
		fireEvent.click(getByTestId("provider-format-template-new"));
		const input = getByTestId("provider-format-save-name");
		// Collision: the taken name warns inline and confirms nothing.
		fireEvent.input(input, { target: { value: "taken" } });
		expect(getByTestId("provider-format-name-exists")).toBeTruthy();
		expect(updates.filter((u) => u.k === "generationFormat").length).toBe(0);
		// A fresh name creates the custom and applies it (manual stays manual).
		fireEvent.input(input, { target: { value: "My Template" } });
		expect(queryByTestId("provider-format-name-exists")).toBeNull();
		fireEvent.click(getByTestId("provider-format-save-confirm"));
		await settle();
		const applied = lastStored(updates);
		expect(applied?.mode).toBe("manual");
		expect(applied?.selection).toBe("custom:ftpl_2");
		expect(applied?.format?.inputSequence).toBe("<u> ");
	});

	it("💾 save-into and ✏ rename act on the selected custom via updateFormatTemplate", async () => {
		templates.push({ id: "ftpl_a", name: "Alpha", payload: { mode: "manual", inputSequence: "old" } });
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "custom:ftpl_a", format: { mode: "manual", inputSequence: "new: " } },
		});
		const { getByTestId } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);
		await settle();
		// 💾 — the current fields land in the selected custom's payload.
		fireEvent.click(getByTestId("provider-format-template-save"));
		await settle();
		expect(updateCalls.at(-1)?.id).toBe("ftpl_a");
		expect((updateCalls.at(-1)?.patch.payload as { inputSequence?: string }).inputSequence).toBe("new: ");
		// ✏ — the morph opens prefilled; confirm renames via the API.
		fireEvent.click(getByTestId("provider-format-template-rename"));
		const renameInput = getByTestId("provider-format-save-name") as HTMLInputElement;
		expect(renameInput.value).toBe("Alpha");
		fireEvent.input(renameInput, { target: { value: "Alpha 2" } });
		fireEvent.click(getByTestId("provider-format-save-confirm"));
		await settle();
		expect(updateCalls.at(-1)?.patch.name).toBe("Alpha 2");
		expect(templates.find((tpl) => tpl.id === "ftpl_a")?.name).toBe("Alpha 2");
	});

	it("🗑 delete: confirm modal, then the template is deleted and a selection pointing at it degrades to backend", async () => {
		templates.push({ id: "ftpl_doomed", name: "Doomed", payload: { mode: "manual" } });
		const updates: Array<{ k: string; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "custom:ftpl_doomed", format: { mode: "manual", inputSequence: "X: " } },
		});
		const { getByTestId, queryByTestId, getByText } = render(
			<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />,
		);
		await settle();
		fireEvent.click(getByTestId("provider-format-template-delete"));
		// The destructive confirm modal (inline) — its title renders.
		await settle();
		expect(getByText("providerFormat.templateDeleteTitle")).toBeTruthy();
		expect(getByText("providerFormat.templateDeleteBody")).toBeTruthy();
		// Confirm = the last button in the modal.
		const modal = getByText("providerFormat.templateDeleteTitle").closest("div")!.parentElement!;
		const buttons = Array.from(modal.querySelectorAll("button"));
		fireEvent.click(buttons[buttons.length - 1]);
		await settle();
		expect(deleteCalls).toEqual(["ftpl_doomed"]);
		expect(templates.length).toBe(0);
		const degraded = lastStored(updates);
		expect(degraded?.selection).toBe("backend");
		expect(degraded?.mode).toBe("manual"); // the fields stay — the profile is their source
		expect(degraded?.format?.inputSequence).toBe("X: ");
		expect(queryByTestId("provider-format-template-delete")).toBeTruthy();
	});

	it("custom-targeting actions (💾✏🗑⬇) stay disabled for backend/builtin selections; 🔄 disabled for backend only", () => {
		const form = makeForm({
			generationFormat: { mode: "manual", selection: "builtin:chatml", format: { mode: "manual" } },
		});
		const { getByTestId, unmount } = render(<ProviderFormatPanel form={form} updateForm={mock()} tcTemplateSource="default" />);
		expect((getByTestId("provider-format-template-save") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("provider-format-template-rename") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("provider-format-template-delete") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("provider-format-template-export") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("provider-format-template-reapply") as HTMLButtonElement).disabled).toBe(false);
		unmount(); // RTL queries are body-wide — drop the first view
		// Backend selection: reapply disabled too (nothing to restore).
		const backendForm = makeForm({ generationFormat: { mode: "manual", selection: "backend", format: { mode: "manual" } } });
		const view2 = render(<ProviderFormatPanel form={backendForm} updateForm={mock()} tcTemplateSource="default" />);
		expect((view2.getByTestId("provider-format-template-reapply") as HTMLButtonElement).disabled).toBe(true);
		expect((view2.getByTestId("provider-format-template-new") as HTMLButtonElement).disabled).toBe(false);
	});
});
