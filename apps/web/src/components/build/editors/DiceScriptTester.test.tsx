/**
 * DiceScriptTester — characterization + SS-7 warning-flow tests.
 *
 * The dice panel is the same run flow as ScriptTester with kind "dice": the
 * run routes through `scriptSafetyWarningFlow`, and a test run of an imported
 * never-enabled script only proceeds on the acknowledged path
 * (`warningAcknowledged: true`, plan decision 14). This file pins the dice
 * side of that matrix (the full matrix lives in the flow's own suite and the
 * ScriptTester suite; here: block-until-confirm, suppressed-direct, in-app,
 * cancel, and the payload shape the endpoint receives).
 *
 * Identity i18n (`t` returns the key verbatim) + mocked script/settings APIs,
 * matching ScriptTester.test.tsx.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ScriptRecord } from "../../../api/types.js";

useDomEnv();

const testScript = mock(() => Promise.resolve({
	kind: "dice" as const,
	checks: [],
	sampleRolls: [],
	discoveryError: null,
}));
const realI18nContext = await import("../../../i18n/context.js");
const realScriptApi = await import("../../../api/script-api.js");
const realSettingsApi = await import("../../../api/settings-api.js");

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (k: string) => k,
		tDynamic: (k: string) => k,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

mock.module("../../../api/script-api.js", () => ({
	...realScriptApi,
	testScript,
}));

const getScriptSafetySettings = mock(async () => ({ suppressImportWarnings: false, updatedAt: "" }));
const updateScriptSafetySettings = mock(async (input: { suppressImportWarnings: boolean }) => ({
	suppressImportWarnings: input.suppressImportWarnings,
	updatedAt: "",
}));
mock.module("../../../api/settings-api.js", () => ({
	...realSettingsApi,
	getScriptSafetySettings,
	updateScriptSafetySettings,
}));

let DiceScriptTester: typeof import("./DiceScriptTester.js").DiceScriptTester;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
const { useScriptSafetySettingsStore } = await import("../../../stores/script-safety-settings-store.js");

beforeAll(async () => {
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ DiceScriptTester } = await import("./DiceScriptTester.js"));
});

const UNTRUSTED_IMPORT: Pick<ScriptRecord, "origin" | "firstEnabledAt"> = { origin: "imported", firstEnabledAt: null };
const IN_APP: Pick<ScriptRecord, "origin" | "firstEnabledAt"> = { origin: "in_app", firstEnabledAt: null };

function renderTester(props: Partial<Parameters<typeof DiceScriptTester>[0]> = {}) {
	return render(<DiceScriptTester scriptId="script_1" code="context.dice.roll('1d6');" isMobile={false} {...props} />);
}

function run(view: ReturnType<typeof render>) {
	fireEvent.click(view.getByText("script_test_run"));
}

describe("DiceScriptTester (characterization)", () => {
	beforeEach(() => {
		testScript.mockReset();
		testScript.mockResolvedValue({ kind: "dice", checks: [], sampleRolls: [], discoveryError: null });
		useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
	});

	it("a null scriptId never calls testScript", () => {
		const view = renderTester({ scriptId: null });
		run(view);
		expect(testScript).not.toHaveBeenCalled();
	});

	it("an in-app script runs directly, without a modal or the ack flag", async () => {
		const view = renderTester({ script: IN_APP });
		run(view);
		await waitFor(() => {
			expect(testScript).toHaveBeenCalledWith("script_1", {
				messages: [{ role: "user", content: "test" }],
				code: "context.dice.roll('1d6');",
			});
		});
		expect(view.queryByText("script_safety_warning_body")).toBeNull();
	});
});

describe("DiceScriptTester SS-7 warning flow", () => {
	beforeEach(() => {
		testScript.mockReset();
		testScript.mockResolvedValue({ kind: "dice", checks: [], sampleRolls: [], discoveryError: null });
		useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
	});

	it("an untrusted import is blocked by the plain warning until confirmed; the run then carries warningAcknowledged", async () => {
		const view = renderTester({ script: UNTRUSTED_IMPORT });
		run(view);
		// The honest body renders in the visible panel + the Modal's sr-only
		// description pair.
		expect(view.getAllByText("script_safety_warning_body").length).toBe(2);
		expect(testScript).not.toHaveBeenCalled();
		fireEvent.click(view.getByText("script_safety_warning_confirm_run"));
		await waitFor(() => {
			expect(testScript).toHaveBeenCalledWith("script_1", expect.objectContaining({ warningAcknowledged: true }));
		});
	});

	it("a suppressed untrusted import runs directly with the flag (stored suppression = acknowledgement)", async () => {
		useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
		const view = renderTester({ script: UNTRUSTED_IMPORT });
		run(view);
		await waitFor(() => {
			expect(testScript).toHaveBeenCalledWith("script_1", expect.objectContaining({ warningAcknowledged: true }));
		});
		expect(view.queryByText("script_safety_warning_body")).toBeNull();
	});

	it("findings block with the findings modal ALONE (honest text inside); cancel sends nothing", async () => {
		const view = renderTester({ script: UNTRUSTED_IMPORT, code: "eval('x');" });
		run(view);
		expect(view.getAllByText("script_safety_findings_title").length).toBe(2);
		// Inside the findings modal the honest text is the visible paragraph only
		// (the sr-only pair describes the findings intro, not the warning).
		expect(view.getAllByText("script_safety_warning_body").length).toBe(1);
		expect(view.getByText("script_safety_rule_unsafe_eval")).toBeTruthy();
		fireEvent.click(view.getByText("cancel"));
		expect(testScript).not.toHaveBeenCalled();
	});

	it("«Show in code» forwards the first finding line to the host without running", async () => {
		const onRevealLine = mock((_line: number) => {});
		const view = renderTester({ script: UNTRUSTED_IMPORT, code: "context.dice.roll('1d6');\neval('y');", onRevealLine });
		run(view);
		fireEvent.click(view.getByText("script_safety_findings_show_in_code"));
		expect(onRevealLine).toHaveBeenCalledWith(2);
		expect(testScript).not.toHaveBeenCalled();
	});
});
