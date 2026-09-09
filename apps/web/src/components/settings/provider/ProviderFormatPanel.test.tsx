/**
 * LS-10 pane render states (owner design 2026-09-09): auto = the template
 * dropdown (builtins selectable WITHOUT manual editing) + the honest fallback
 * note; manual = the flat sequence editor (no accordion wrapper — LS-6c) +
 * the LS-9 empty-stops hint + save-as-new morph + collision warning.
 *
 * The RPC client seam is mocked at the module boundary (T2: the format-
 * template library is a true external boundary — apps/web's per-file process
 * makes the mock.module leak structurally impossible here).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { FormState } from "../../modals/ProviderModal.js";
import type { ProviderGenerationFormat } from "@vibe-tavern/domain";
import { GENERATION_FORMAT_MODE } from "@vibe-tavern/domain";

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

const createdTemplates: Array<{ id: string; name: string }> = [];

mock.module("../../../api/format-template-api.js", () => ({
	...realFormatApi,
	listFormatTemplates: async () =>
		createdTemplates.map((tpl, index) => ({
			id: tpl.id,
			name: tpl.name,
			sortOrder: index,
			payload: { mode: "manual" },
			createdAt: "2026-09-09",
			updatedAt: "2026-09-09",
		})),
	createFormatTemplate: async (input: { name: string }) => {
		const tpl = { id: `ftpl_${createdTemplates.length + 1}`, name: input.name };
		createdTemplates.push(tpl);
		return { id: tpl.id, name: tpl.name, sortOrder: createdTemplates.length - 1, payload: { mode: "manual" }, createdAt: "2026-09-09", updatedAt: "2026-09-09" };
	},
	deleteFormatTemplate: async () => {},
	updateFormatTemplate: async () => {
		throw new Error("not used in these pins");
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

describe("ProviderFormatPanel (LS-10)", () => {
	beforeAll(() => {});

	it("AUTO: renders the mode toggle, the template dropdown, the backend status and the honest fallback note (profile format unset)", () => {
		const { getByText, getByTestId, queryByTestId } = render(<ProviderFormatPanel form={makeForm()} updateForm={mock()} tcTemplateSource="default" />);
		expect(getByText("providerFormat.modeAuto")).toBeTruthy();
		expect(getByTestId("provider-format-template")).toBeTruthy();
		expect(getByText("providerFormat.statusDefault")).toBeTruthy();
		expect(getByText("providerFormat.fallbackNote")).toBeTruthy();
		// No sequence editor and no empty-stops hint in auto (the owner rule:
		// the manual editor belongs to manual mode only).
		expect(queryByTestId("provider-format-sequences-toggle")).toBeNull();
		expect(queryByTestId("provider-format-stops-empty-hint")).toBeNull();
	});

	it("MANUAL: the flat editor + the LS-9 empty-stops hint appear (no accordion wrapper)", () => {
		const form = makeForm({
			generationFormat: { mode: "manual", format: { mode: "manual", inputSequence: "User: " } },
		});
		const { getByTestId, queryByText } = render(<ProviderFormatPanel form={form} updateForm={mock()} tcTemplateSource="default" />);
		expect(getByTestId("provider-format-sequences-toggle")).toBeTruthy();
		expect(getByTestId("provider-format-preview-toggle")).toBeTruthy();
		expect(getByTestId("provider-format-stops-empty-hint")).toBeTruthy();
		// The fallback note is AUTO-only (the profile is now the source).
		expect(queryByText("providerFormat.fallbackNote")).toBeNull();
	});

	it("MANUAL with user stops set: the empty-stops hint does NOT render", () => {
		const form = makeForm({
			stopSequences: ["User:"],
			generationFormat: { mode: "manual", format: { mode: "manual", inputSequence: "User: " } },
		});
		const { getByTestId, queryByTestId } = render(<ProviderFormatPanel form={form} updateForm={mock()} tcTemplateSource="default" />);
		expect(queryByTestId("provider-format-stops-empty-hint")).toBeNull();
	});

	it("save-as-new morph: the name input appears, a collision shows the warning, success adopts the custom (auto + selection)", async () => {
		const updates: Array<{ k: keyof FormState; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", format: { mode: "manual", inputSequence: "<u> " } },
		});
		const { getByTestId, queryByTestId } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);

		fireEvent.click(getByTestId("provider-format-save-new"));
		const nameInput = getByTestId("provider-format-save-name");
		fireEvent.input(nameInput, { target: { value: "My Template" } });
		expect(queryByTestId("provider-format-name-exists")).toBeNull();
		fireEvent.click(getByTestId("provider-format-save-confirm"));
		// The save path is async (createFormatTemplate promise) — settle before
		// asserting the adoption (the codebase tick idiom).
		await new Promise((resolve) => setTimeout(resolve, 10));

		const adoption = updates.find((u) => u.k === "generationFormat") as { v: ProviderGenerationFormat } | undefined;
		expect(adoption?.v.mode).toBe("auto");
		expect(adoption?.v.selection).toBe("custom:ftpl_1");
		createdTemplates.length = 0;
	});

	it("save-as-new collision (an existing template name): the inline warning shows, no adoption fires", async () => {
		createdTemplates.push({ id: "ftpl_x", name: "Taken" });
		const updates: Array<{ k: keyof FormState; v: unknown }> = [];
		const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {
			updates.push({ k, v });
		});
		const form = makeForm({
			generationFormat: { mode: "manual", format: { mode: "manual", inputSequence: "<u> " } },
		});
		const { getByTestId } = render(<ProviderFormatPanel form={form} updateForm={updateForm} tcTemplateSource="default" />);
		// The template library loads via a useEffect promise — settle before
		// typing so the collision check sees the loaded list.
		await new Promise((resolve) => setTimeout(resolve, 10));
		fireEvent.click(getByTestId("provider-format-save-new"));
		fireEvent.input(getByTestId("provider-format-save-name"), { target: { value: "taken" } });
		expect(getByTestId("provider-format-name-exists")).toBeTruthy();
		expect(updates.length).toBe(0);
		createdTemplates.length = 0;
	});

	it("native-TC (kobold) status reads native", () => {
		const { getByText } = render(<ProviderFormatPanel form={makeForm()} updateForm={mock()} tcTemplateSource="native" />);
		expect(getByText("providerFormat.statusNative")).toBeTruthy();
	});
});
