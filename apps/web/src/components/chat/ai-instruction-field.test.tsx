/**
 * AI-editor instruction field + the «Шаблоны ▾» menu
 * (AI_EDITOR_INSTRUCTION_TEMPLATES step 4) — pins the insert semantics the
 * owner ruled on (empty field → replace; non-empty → append after a
 * newline), save-current (name = first line, disabled while empty), inline
 * rename, delete-after-confirm, and the empty state. The API module is
 * mocked at the boundary (list/create/update/delete); everything else
 * (field, popover, hook state sync) is real.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { within } = await import("@testing-library/react");
const { useState } = await import("react");
import type { AiInstructionTemplate } from "@vibe-tavern/api-contracts";

const realApi = await import("../../api/ai-instruction-template-api.js");
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

const listMock = mock(() => Promise.resolve<AiInstructionTemplate[]>([]));
const createMock = mock((input: { name: string; text: string }) =>
	Promise.resolve(makeTemplate("aitpl_new", input.name, input.text, 2)));
const updateMock = mock((id: string, input: { name?: string; text?: string }) =>
	Promise.resolve(makeTemplate(id, input.name ?? "?", input.text ?? "?", 0)));
const deleteMock = mock((_id: string) => Promise.resolve());

mock.module("../../api/ai-instruction-template-api.js", () => ({
	...realApi,
	listAiInstructionTemplates: listMock,
	createAiInstructionTemplate: createMock,
	updateAiInstructionTemplate: updateMock,
	deleteAiInstructionTemplate: deleteMock,
}));

mock.module("../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (key: string) => key,
		tDynamic: (key: string) => key,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

// Desktop popover path by default (the mobile sheet halves share the same
// body component — the dual-mode canon pins one body, two shells).
mock.module("../../hooks/use-mobile.js", () => ({
	...realMobileHook,
	useIsMobile: () => false,
}));

let AiInstructionField: typeof import("./ai-instruction-field.js").AiInstructionField;
beforeAll(async () => {
	({ AiInstructionField } = await import("./ai-instruction-field.js"));
});

function makeTemplate(id: string, name: string, text: string, sortOrder: number): AiInstructionTemplate {
	return { id, name, text, sortOrder, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
}

const TPL_SHORTEN = makeTemplate("aitpl_0001", "Сократить", "Сократи ответ до трёх абзацев.", 0);
const TPL_DEPATHOS = makeTemplate("aitpl_0002", "Без пафоса", "Убери пафос, оставь суть.", 1);

/** Stateful harness — the field owns nothing; the host owns the value. */
function FieldHarness({ initial }: { initial: string }) {
	const [value, setValue] = useState(initial);
	return (
		<AiInstructionField
			instruction={value}
			onChange={(next) => setValue(next)}
		/>
	);
}

/** The popover portals to document.body — query there, not the container. */
function body(): ReturnType<typeof within> {
	return within(document.body);
}

async function openMenu() {
	const trigger = await body().findByText("message_ai_editor_templates_button");
	await act(async () => { fireEvent.click(trigger); });
}

beforeEach(() => {
	listMock.mockReset();
	listMock.mockResolvedValue([TPL_SHORTEN, TPL_DEPATHOS]);
	createMock.mockReset();
	createMock.mockImplementation(async (input: { name: string; text: string }) =>
		makeTemplate("aitpl_new", input.name, input.text, 2));
	updateMock.mockReset();
	updateMock.mockImplementation(async (_id: string, input: { name?: string; text?: string }) =>
		makeTemplate("aitpl_0001", input.name ?? TPL_SHORTEN.name, input.text ?? TPL_SHORTEN.text, 0));
	deleteMock.mockReset();
	deleteMock.mockResolvedValue(undefined);
});

describe("AiInstructionField — template insert (owner ruling 2)", () => {
	it("empty field: picking a template replaces the value with its text verbatim", async () => {
		render(<FieldHarness initial="" />);
		await openMenu();
		await act(async () => { fireEvent.click(await body().findByText("Сократить")); });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe("Сократи ответ до трёх абзацев.");
	});

	it("non-empty field: picking a template appends after a newline", async () => {
		render(<FieldHarness initial="перепиши от первого лица" />);
		await openMenu();
		await act(async () => { fireEvent.click(await body().findByText("Без пафоса")); });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe("перепиши от первого лица\nУбери пафос, оставь суть.");
	});
});

describe("AiInstructionField — save current as template (owner ruling 3)", () => {
	it("creates a template named after the first line, carrying the full text", async () => {
		render(<FieldHarness initial="" />);
		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "Сократить покороче\nи по делу, пожалуйста" } });

		await openMenu();
		await act(async () => { fireEvent.click(await body().findByText("message_ai_editor_templates_save_current")); });

		await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
		expect(createMock).toHaveBeenCalledWith({
			name: "Сократить покороче",
			text: "Сократить покороче\nи по делу, пожалуйста",
		});
	});

	it("keeps the save action disabled while the instruction is empty", async () => {
		render(<FieldHarness initial="" />);
		await openMenu();
		const saveBtn = (await body().findByText("message_ai_editor_templates_save_current")).closest("button");
		if (!(saveBtn instanceof HTMLButtonElement)) throw new Error("save button not found");
		expect(saveBtn.disabled).toBe(true);
		expect(createMock).not.toHaveBeenCalled();
	});
});

describe("AiInstructionField — rename and delete", () => {
	it("renames inline: the field seeds with the current name, Enter commits", async () => {
		render(<FieldHarness initial="" />);
		await openMenu();
		const renameButtons = await body().findAllByLabelText("message_ai_editor_templates_rename");
		await act(async () => { fireEvent.click(renameButtons[0]!); });

		const input = await body().findByDisplayValue("Сократить");
		fireEvent.change(input, { target: { value: "Короче" } });
		await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

		await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
		expect(updateMock).toHaveBeenCalledWith("aitpl_0001", { name: "Короче" });
	});

	it("deletes only after the destructive confirm", async () => {
		render(<FieldHarness initial="" />);
		await openMenu();
		const deleteButtons = await body().findAllByLabelText("message_ai_editor_templates_delete");
		await act(async () => { fireEvent.click(deleteButtons[0]!); });

		// Confirm dialog first — nothing deleted before it.
		expect(deleteMock).not.toHaveBeenCalled();
		await act(async () => { fireEvent.click(await body().findByText("message_ai_editor_templates_delete_confirm")); });

		await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
		expect(deleteMock).toHaveBeenCalledWith("aitpl_0001");
	});
});

describe("AiInstructionField — empty state", () => {
	it("shows the no-templates hint when the library is empty", async () => {
		listMock.mockResolvedValue([]);
		render(<FieldHarness initial="" />);
		await openMenu();
		expect(await body().findByText("message_ai_editor_templates_empty")).toBeTruthy();
	});
});
