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
import type { ChangeEvent } from "react";
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
const realAppClient = await import("../../../app-client.js");
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
mock.module("../../../app-client.js", () => ({
	...realAppClient,
 testScript,
}));

// AutoTextarea sizes via scrollHeight in a useLayoutEffect; in happy-dom that
// is 0 and irrelevant to the logic under test, so stub it to a plain textarea.
mock.module("../../shared/auto-textarea.js", () => ({
	...realAutoTextarea,
	AutoTextarea: ({ value, onChange, readOnly }: { value?: string; onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void; readOnly?: boolean }) => (
		<textarea data-testid="auto-textarea" value={value} onChange={onChange} readOnly={readOnly} />
	),
}));

const mockTestScript = testScript;

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
