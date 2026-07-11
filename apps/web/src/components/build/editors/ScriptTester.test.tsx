/**
 * ScriptTester — characterization tests.
 *
 * Pins the OBSERVABLE behaviors of the test panel extracted from
 * `useScriptPanel` (SCRIPT_EDITOR_GOD_OBJECT_AUDIT). The extraction is a
 * mechanical move of ~170 lines into this component; these tests guard the
 * logic-bearing surfaces so a future regression (dropped trim, wrong payload
 * shape, broken Cmd+Enter, lost pre-fill) fails loudly:
 *
 *   - payload: a single line posts one user message; each non-empty line is its
 *     own message (messageCount contract);
 *   - guards: empty/whitespace input and a null scriptId never call testScript;
 *   - shortcut: Cmd/Ctrl+Enter inside the input triggers a run;
 *   - pre-fill: the `characterName` prop seeds the advanced character-name
 *     field (the P2 snapshot pre-fill, preserved across the extraction);
 *   - result: output renders the personality/scenario blocks; no-output renders
 *     the no-effect warning.
 *
 * Runner: vitest (apps/web uses vitest, NOT bun:test — see vitest.config.ts;
 * vi.mock is file-scoped + hoisted, so the mock.module gotcha doesn't apply).
 * DOM via happy-dom (configured globally per-file).
 *
 * Identity i18n (`t` returns the key verbatim) mirrors LorebookEditor.test.tsx,
 * so assertion strings are the i18n keys. `AutoTextarea` is stubbed to a plain
 * textarea to keep the test off happy-dom layout measuring (the real component
 * sizes via scrollHeight, irrelevant to the logic under test).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChangeEvent } from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ScriptTester } from "./ScriptTester.js";
import { testScript } from "../../../app-client.js";

// ── Module-boundary mocks (hoisted above the ScriptTester import) ────────

// Identity i18n — assertion strings match the i18n keys verbatim.
vi.mock("../../../i18n/context.js", () => ({
	useT: () => ({
		t: (k: string) => k,
		tDynamic: (k: string) => k,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

// testScript RPC — the single side effect of the panel.
vi.mock("../../../app-client.js", () => ({
	testScript: vi.fn(),
}));

// AutoTextarea sizes via scrollHeight in a useLayoutEffect; in happy-dom that
// is 0 and irrelevant to the logic under test, so stub it to a plain textarea.
vi.mock("../../shared/auto-textarea.js", () => ({
	AutoTextarea: ({ value, onChange, readOnly }: { value?: string; onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void; readOnly?: boolean }) => (
		<textarea data-testid="auto-textarea" value={value} onChange={onChange} readOnly={readOnly} />
	),
}));

const mockTestScript = vi.mocked(testScript);

function renderTester(props: Partial<Parameters<typeof ScriptTester>[0]> = {}) {
	return render(<ScriptTester scriptId="script_1" isMobile={false} {...props} />);
}

describe("ScriptTester (characterization)", () => {
	beforeEach(() => {
		mockTestScript.mockReset();
	});

	it("payload: a single-line input posts one user message to testScript", async () => {
		const { getByPlaceholderText, getByText } = renderTester();
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "hello" } });
		fireEvent.click(getByText("script_test_run"));
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", { messages: [{ role: "user", content: "hello" }] });
		});
	});

	it("payload: each non-empty line becomes its own user message (messageCount)", async () => {
		const { getByPlaceholderText, getByText } = renderTester();
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "a\n\nb" } });
		fireEvent.click(getByText("script_test_run"));
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", {
				messages: [
					{ role: "user", content: "a" },
					{ role: "user", content: "b" },
				],
			});
		});
	});

	it("guard: blank/whitespace input does not call testScript", () => {
		const { getByPlaceholderText, getByText } = renderTester();
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "   " } });
		fireEvent.click(getByText("script_test_run"));
		expect(mockTestScript).not.toHaveBeenCalled();
	});

	it("guard: a null scriptId does not call testScript even with input", () => {
		const { getByPlaceholderText, getByText } = renderTester({ scriptId: null });
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "hi" } });
		fireEvent.click(getByText("script_test_run"));
		expect(mockTestScript).not.toHaveBeenCalled();
	});

	it("shortcut: Cmd/Ctrl+Enter in the input triggers a run", async () => {
		const { getByPlaceholderText } = renderTester();
		const input = getByPlaceholderText("script_test_input_placeholder");
		fireEvent.change(input, { target: { value: "go" } });
		fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
		await waitFor(() => {
			expect(mockTestScript).toHaveBeenCalledWith("script_1", { messages: [{ role: "user", content: "go" }] });
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
			personality: "calm",
			scenario: "forest",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
		const { getByPlaceholderText, getByText, findByText } = renderTester();
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "hi" } });
		fireEvent.click(getByText("script_test_run"));
		// hasAnyOutput (personality/scenario non-empty) → both labels render.
		expect(await findByText("script_test_personality")).toBeTruthy();
		expect(await findByText("script_test_scenario")).toBeTruthy();
	});

	it("result: shows the no-effect warning when the run returns no output", async () => {
		mockTestScript.mockResolvedValue({
			personality: "",
			scenario: "",
			state: {},
			injectedMessages: [],
			console: [],
			shared: {},
			errors: [],
		});
		const { getByPlaceholderText, getByText, findByText } = renderTester();
		fireEvent.change(getByPlaceholderText("script_test_input_placeholder"), { target: { value: "hi" } });
		fireEvent.click(getByText("script_test_run"));
		// No personality/scenario/injected/console/state/shared and no errors → warning.
		expect(await findByText("script_test_no_effect")).toBeTruthy();
	});
});
