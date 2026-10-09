/**
 * ScriptTester — characterization tests.
 *
 * Pins the OBSERVABLE behaviors of the test panel extracted from
 * `useScriptPanel` (SCRIPT_EDITOR_GOD_OBJECT_AUDIT). The extraction is a
 * mechanical move of ~170 lines into this component; these tests guard the
 * logic-bearing surfaces so a future regression (dropped trim, wrong payload
 * shape, broken Cmd+Enter, lost pre-fill) fails loudly:
 *
 *   - payload: every run includes the current unsaved code; a single line
 *     posts one user message, and each non-empty line is its own message
 *     (messageCount contract);
 *   - guards: empty/whitespace input and a null scriptId never call testScript;
 *   - shortcut: Cmd/Ctrl+Enter inside the input triggers a run;
 *   - pre-fill: the `characterName` prop seeds the advanced character-name
 *     field (the P2 snapshot pre-fill, preserved across the extraction);
 *   - result: output renders the personality/scenario blocks; no-output renders
 *     the no-effect warning.
 *
 * Runner: bun:test with scoped happy-dom.
 *
 * Identity i18n (`t` returns the key verbatim) mirrors LorebookEditor.test.tsx,
 * so assertion strings are the i18n keys. `AutoTextarea` is stubbed to a plain
 * textarea to keep the test off happy-dom layout measuring (the real component
 * sizes via scrollHeight, irrelevant to the logic under test).
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const testScript = mock(() => Promise.resolve({
	kind: "prompt" as const,
	personality: "",
	scenario: "",
	state: {},
	injectedMessages: [],
	console: [],
	shared: {},
	errors: [],
}));
const realI18nContext = await import("../../../i18n/context.js");
const realScriptApi = await import("../../../api/script-api.js");
const realSettingsApi = await import("../../../api/settings-api.js");
const realAutoTextarea = await import("../../shared/auto-textarea.js");

// ── Module-boundary mocks (hoisted above the ScriptTester import) ────────

// Identity i18n — assertion strings match the i18n keys verbatim.
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

// testScript RPC — the single side effect of the panel.
mock.module("../../../api/script-api.js", () => ({
	...realScriptApi,
	testScript,
}));

// SS-7: the script-safety settings API (the suppression singleton) — the
// real Zustand store stays; tests drive its state directly.
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

// AutoTextarea sizes via scrollHeight in a useLayoutEffect; in happy-dom that
// is 0 and irrelevant to the logic under test, so stub it to a plain textarea.
mock.module("../../shared/auto-textarea.js", () => ({
	...realAutoTextarea,
	AutoTextarea: ({ value, onChange, readOnly, placeholder, className, onKeyDown }: { value?: string; onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void; readOnly?: boolean; placeholder?: string; className?: string; onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void }) => (
		<textarea data-testid="auto-textarea" value={value} onChange={onChange} readOnly={readOnly} placeholder={placeholder} className={className} onKeyDown={onKeyDown} />
	),
}));

const mockTestScript = testScript;
const { useScriptSafetySettingsStore } = await import("../../../stores/script-safety-settings-store.js");

let ScriptTester: typeof import("./ScriptTester.js").ScriptTester;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ ScriptTester } = await import("./ScriptTester.js"));
});

function renderTester(props: Partial<Parameters<typeof ScriptTester>[0]> = {}) {
	return render(<ScriptTester scriptId="script_1" code="draft code" isMobile={false} {...props} />);
}

describe("ScriptTester (characterization)", () => {
	beforeEach(() => {
		mockTestScript.mockReset();
		mockTestScript.mockResolvedValue({
			kind: "prompt",
			personality: "",
			scenario: "",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
	});

	it("payload: a single-line input posts one user message to testScript", async () => {
		const { getByPlaceholderText, getByText } = renderTester();
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "hello");
		fireEvent.click(getByText("script_test_run"));
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", { messages: [{ role: "user", content: "hello" }], code: "draft code" });
		});
	});

	it("payload: each non-empty line becomes its own user message (messageCount)", async () => {
		const { getByPlaceholderText, getByText } = renderTester();
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "a{Enter}{Enter}b");
		fireEvent.click(getByText("script_test_run"));
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", {
				messages: [
					{ role: "user", content: "a" },
					{ role: "user", content: "b" },
				],
				code: "draft code",
			});
		});
	});

	it("guard: blank/whitespace input does not call testScript", async () => {
		const { getByPlaceholderText, getByText } = renderTester();
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "   ");
		fireEvent.click(getByText("script_test_run"));
		expect(mockTestScript).not.toHaveBeenCalled();
	});

	it("guard: a null scriptId does not call testScript even with input", async () => {
		const { getByPlaceholderText, getByText } = renderTester({ scriptId: null });
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "hi");
		fireEvent.click(getByText("script_test_run"));
		expect(mockTestScript).not.toHaveBeenCalled();
	});

	it("shortcut: Cmd/Ctrl+Enter in the input triggers a run", async () => {
		const { getByPlaceholderText } = renderTester();
		const input = getByPlaceholderText("script_test_input_placeholder");
		await userEvent.setup().type(input, "go");
		fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", { messages: [{ role: "user", content: "go" }], code: "draft code" });
		});
	});

	it("pre-fill: the characterName prop seeds the advanced character-name field", async () => {
		const { getByText, findByDisplayValue } = renderTester({ characterName: "Alice" });
		fireEvent.click(getByText("script_test_advanced", { exact: false }));
		// The advanced character-name input carries the prop value (P2 pre-fill).
		expect(await findByDisplayValue("Alice")).toBeTruthy();
	});

	it("result: renders the personality + scenario blocks when the run returns output", async () => {
		mockTestScript.mockResolvedValue({
			kind: "prompt",
			personality: "calm",
			scenario: "forest",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
		const { getByPlaceholderText, getByText, findByText } = renderTester();
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "hi");
		fireEvent.click(getByText("script_test_run"));
		// hasAnyOutput (personality/scenario non-empty) → both labels render.
		expect(await findByText("script_test_personality")).toBeTruthy();
		expect(await findByText("script_test_scenario")).toBeTruthy();
	});

	it("result: shows the no-effect warning when the run returns no output", async () => {
		mockTestScript.mockResolvedValue({
			kind: "prompt",
			personality: "",
			scenario: "",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
		const { getByPlaceholderText, getByText, findByText } = renderTester();
		await userEvent.setup().type(getByPlaceholderText("script_test_input_placeholder"), "hi");
		fireEvent.click(getByText("script_test_run"));
		// No personality/scenario/injected/console/state/shared and no errors → warning.
		expect(await findByText("script_test_no_effect")).toBeTruthy();
	});
});

// ── SS-7: the warning flow gating test runs ────────────────────────────────
// The full matrix lives in scriptSafetyWarningFlow's own suite; these tests
// pin the RUN-side wiring: which modal blocks the request, what the request
// carries on the acknowledged path, and the intended repetition.
const UNTRUSTED_IMPORT = { origin: "imported" as const, firstEnabledAt: null };
const TRUSTED_IMPORT = { origin: "imported" as const, firstEnabledAt: "2026-01-01T00:00:00.000Z" };
const IN_APP = { origin: "in_app" as const, firstEnabledAt: null };

describe("ScriptTester SS-7 warning flow", () => {
	beforeEach(() => {
		mockTestScript.mockReset();
		mockTestScript.mockResolvedValue({
			kind: "prompt",
			personality: "",
			scenario: "",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
		// Seed the loaded sentinel so the component's load() is a no-op.
		useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
	});

	async function typeAndRun(view: ReturnType<typeof render>) {
		await userEvent.setup().type(view.getByPlaceholderText("script_test_input_placeholder"), "hi");
		fireEvent.click(view.getByText("script_test_run"));
	}

	it("an untrusted import is blocked by the plain warning until confirmed; the run then carries warningAcknowledged", async () => {
		const view = renderTester({ script: UNTRUSTED_IMPORT });
		await typeAndRun(view);
		expect(view.getAllByText("script_safety_warning_body").length).toBe(2);
		expect(mockTestScript).not.toHaveBeenCalled();
		fireEvent.click(view.getByText("script_safety_warning_confirm_run"));
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", expect.objectContaining({ warningAcknowledged: true }));
		});
	});

	it("a suppressed untrusted import runs directly — the stored flag IS the acknowledgement (decision 14)", async () => {
		useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
		const view = renderTester({ script: UNTRUSTED_IMPORT });
		await typeAndRun(view);
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", expect.objectContaining({ warningAcknowledged: true }));
		});
		expect(view.queryByText("script_safety_warning_body")).toBeNull();
	});

	it("an in-app script runs without a modal and without the ack flag", async () => {
		const view = renderTester({ script: IN_APP });
		await typeAndRun(view);
		// Exact-object match pins the ABSENCE of warningAcknowledged (the
		// acknowledged path is imported-never-enabled only).
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", { messages: [{ role: "user", content: "hi" }], code: "draft code" });
		});
		expect(view.queryByText("script_safety_warning_body")).toBeNull();
	});

	it("an untrusted import with findings gets the findings modal ALONE, honest text inside; cancel sends nothing", async () => {
		const view = renderTester({ script: UNTRUSTED_IMPORT, code: "eval('x');" });
		await typeAndRun(view);
		expect(view.getAllByText("script_safety_findings_title").length).toBe(2);
		expect(view.getByText("script_safety_warning_body")).toBeTruthy();
		expect(view.getByText("script_safety_rule_unsafe_eval")).toBeTruthy();
		fireEvent.click(view.getByText("cancel"));
		expect(mockTestScript).not.toHaveBeenCalled();
	});

	it("a TRUSTED import with findings still gets the findings modal (origin-based) — without the honest text", async () => {
		const view = renderTester({ script: TRUSTED_IMPORT, code: "eval('x');" });
		await typeAndRun(view);
		expect(view.getAllByText("script_safety_findings_title").length).toBe(2);
		expect(view.queryByText("script_safety_warning_body")).toBeNull();
	});

	it("the warning REPEATS on the next run after a cancel (decision 11 — intended)", async () => {
		const view = renderTester({ script: UNTRUSTED_IMPORT });
		await typeAndRun(view);
		fireEvent.click(view.getByText("cancel"));
		expect(mockTestScript).not.toHaveBeenCalled();
		await typeAndRun(view);
		expect(view.getAllByText("script_safety_warning_body").length).toBe(2);
	});

	it("«Show in code» from the findings modal forwards the first line to the host", async () => {
		const onRevealLine = mock((_line: number) => {});
		const view = renderTester({ script: UNTRUSTED_IMPORT, code: "context.state.set('x', 1);\neval('y');", onRevealLine });
		await typeAndRun(view);
		fireEvent.click(view.getByText("script_safety_findings_show_in_code"));
		expect(onRevealLine).toHaveBeenCalledWith(2);
		expect(mockTestScript).not.toHaveBeenCalled();
	});
});
