/**
 * RegexAiAssistantModal — DOM characterization (REGEX_AI_ASSISTANT_PLAN Wave 4).
 *
 * Pins the plan's five behaviors:
 *   1. Generation lands the draft fields in the preview block.
 *   2. Invisible-character verdict: removed spans get the visible ⟨…⟩ marker
 *      (before/after look identical for ZWSP — the marker is the only proof)
 *      plus the removal count (passed as a NUMBER).
 *   3. Apply writes to the EDITOR DRAFT ONLY: patch carries disabled:true
 *      (never auto-enabled), full depth mapping, and the modal closes.
 *   4. Auto-refine is bounded at 2 attempts on no-match with a user sample.
 *   5. No-providers guard replaces the content area.
 *
 * The regex engine is the REAL pipeline engine (compileRegexScript) — only the
 * transport (requestRegexAssist) and the provider runner are mocked.
 */
import { beforeAll, afterEach, describe, expect, it, mock } from "bun:test";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
let userEvent: typeof import("@testing-library/user-event").default;
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// i18n passthrough: keys verbatim, interpolated values appended so counts are
// assertable (`regexAssistant.removedCount` + the numeric value).
const realI18n = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
	...realI18n,
	useT: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts && opts.count !== undefined ? `${key}:${String(opts.count)}` : key,
		tDynamic: (key: string, opts?: Record<string, unknown>) =>
			opts && opts.count !== undefined ? `${key}:${String(opts.count)}` : key,
	}),
}));

// Desktop chrome (Modal, not BottomSheet) — stable for assertions.
const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
	...realUseMobile,
	useIsMobile: () => false,
}));

// The assistant runner is transport-adjacent (fetches provider models,
// persists selection) — stub it to a known provider state.
const realRunner = await import("../../shared/ai-assistant/use-ai-assistant-runner.js");
const runnerStub = {
	providerId: "prov-1",
	modelName: "model-x",
	providerModels: [{ id: "model-x" }],
	selectedProfile: { defaultModel: "model-x" },
	streaming: false,
	streamedOutput: "",
	streamedReasoning: "",
	error: null,
	doneMetadata: null,
	handleProviderChange: () => {},
	handleModelChange: () => {},
	runStream: () => Promise.resolve(),
	stop: () => {},
	resetStreamState: () => {},
};
mock.module("../../shared/ai-assistant/use-ai-assistant-runner.js", () => ({
	...realRunner,
	useAiAssistantRunner: () => runnerStub,
}));

// The only transport mock — the regex engine below it is real.
const realAssist = await import("../../../api/regex-assist-api.js");
const assistMock = mock(async (_body: unknown) => ({ draft: null as null | Record<string, unknown> }));
mock.module("../../../api/regex-assist-api.js", () => ({
	...realAssist,
	requestRegexAssist: assistMock,
}));

let RegexAiAssistantModal: typeof import("./RegexAiAssistantModal.js").RegexAiAssistantModal;
let useProviderDataStore: typeof import("../../../stores/provider-data-store.js").useProviderDataStore;

beforeAll(async () => {
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ RegexAiAssistantModal } = await import("./RegexAiAssistantModal.js"));
	({ useProviderDataStore } = await import("../../../stores/provider-data-store.js"));
});

afterEach(() => {
	// Call-count assertions (auto-refine ≤2) must not see earlier tests' calls.
	assistMock.mockClear();
});

/** Type into a React-controlled textarea the way React 19 actually notices
 *  (userEvent + focus + selection — fireEvent.change does not propagate
 *  through react-textarea-autosize; same approach as PromptFields tests). */
async function typeInto(el: HTMLTextAreaElement, value: string) {
	const user = userEvent.setup();
	el.focus();
	el.setSelectionRange(0, el.value.length);
	await user.type(el, value, { skipClick: true });
}

function zwspDraft(): Record<string, unknown> {
	return {
		name: "Гигиена невидимых символов",
		findRegex: "/[\\u200B\\u200C\\u200D]/gu",
		replaceString: "",
		trimStrings: [],
		applyTarget: "persist",
		depthMode: "older",
		depthValue: 5,
		explanation: "Удаляет невидимые юникод-пробелы из старых сообщений.",
	};
}

function Harness({ onApply, currentRule }: { onApply: (patch: Record<string, unknown>) => void; currentRule?: Record<string, unknown> }) {
	return (
		<RegexAiAssistantModal
			isOpen={true}
			onClose={() => {}}
			onApply={onApply as never}
			currentRule={currentRule as never}
		/>
	);
}

function setProfiles(n: number) {
	const profiles = Array.from({ length: n }, (_, i) => ({ id: `prov-${i + 1}`, name: `P${i + 1}` }));
	useProviderDataStore.setState({ profiles } as never);
}

describe("RegexAiAssistantModal", () => {
	it("no-providers guard replaces the content area", () => {
		setProfiles(0);
		const { baseElement } = render(<Harness onApply={() => {}} />);
		expect(baseElement.textContent).toContain("regexAssistant.noProvider");
		expect(baseElement.textContent).not.toContain("regexAssistant.taskLabel");
		// Transparent-theme solution pin: the desktop panel must carry the
		// glass-blur-under treatment (AiAssistantPanel) — not a bare bg-surface.
		expect(baseElement.querySelector(".glass-blur-under")).toBeTruthy();
	});

	it("generation lands the draft fields in the preview", async () => {
		setProfiles(1);
		assistMock.mockImplementation(async () => ({ draft: zwspDraft() }));
		const { baseElement, getByText } = render(<Harness onApply={() => {}} />);
		await act(async () => {
			await typeInto(baseElement.querySelector("textarea")!, "убрать невидимые символы");
		});
		await act(async () => {
			fireEvent.click(getByText("regexAssistant.generate"));
		});
		await waitFor(() => expect(baseElement.textContent).toContain("Гигиена невидимых символов"));
		expect(baseElement.textContent).toContain("/[\\u200B\\u200C\\u200D]/gu");
		expect(baseElement.textContent).toContain("promptManager.regex.depthModeOlder");
		expect(assistMock.mock.calls.length).toBe(1);
		const sent = assistMock.mock.calls[0]![0] as { task?: string };
		expect(sent.task).toContain("убрать невидимые символы");
	});

	it("invisible-marker verdict: ⟨⟩ spans between kept text + removal count as a number", async () => {
		setProfiles(1);
		assistMock.mockImplementation(async () => ({ draft: zwspDraft() }));
		const { baseElement, getByText } = render(<Harness onApply={() => {}} />);
		const areas = baseElement.querySelectorAll("textarea");
		await act(async () => {
			await typeInto(areas[0]!, "убрать невидимые символы");
			await typeInto(areas[1]!, "a​b​c"); // ZWSP between letters
		});
		await act(async () => {
			fireEvent.click(getByText("regexAssistant.generate"));
		});
		await waitFor(() => expect(baseElement.textContent).toContain("regexAssistant.testTitle"));
		// Marker view: brackets localize exactly where spans were removed.
		expect(baseElement.textContent).toContain("a⟨⟩b⟨⟩c");
		// Removal count: 2 ZWSP removed — count passed as a NUMBER (2, not "2"-string).
		expect(baseElement.textContent).toContain("regexAssistant.removedCount:2");
	});

	it("apply writes to the editor draft only — disabled:true, depth mapped, modal closes", async () => {
		setProfiles(1);
		assistMock.mockImplementation(async () => ({ draft: zwspDraft() }));
		let closed = false;
		const patches: Array<Record<string, unknown>> = [];
		const { baseElement, getByText } = render(
			<RegexAiAssistantModal
				isOpen={true}
				onClose={() => { closed = true; }}
				onApply={(patch) => patches.push(patch as Record<string, unknown>)}
			/>,
		);
		await act(async () => {
			await typeInto(baseElement.querySelector("textarea")!, "убрать невидимые символы");
		});
		await act(async () => {
			fireEvent.click(getByText("regexAssistant.generate"));
		});
		await waitFor(() => expect(baseElement.textContent).toContain("Гигиена невидимых символов"));
		await act(async () => {
			fireEvent.click(getByText("regexAssistant.apply"));
		});
		expect(patches.length).toBe(1);
		const patch = patches[0]!;
		// Security gate: never auto-enable; the user saves by hand.
		expect(patch.disabled).toBe(true);
		// depthMode "older" + depthValue 5 → one-sided minDepth.
		expect(patch.minDepth).toBe("5");
		expect(patch.maxDepth).toBe("");
		expect(patch.applyTarget).toBe("persist");
		expect(patch.findRegex).toBe("/[\\u200B\\u200C\\u200D]/gu");
		expect(closed).toBe(true);
	});

	it("auto-refine fires at most 2 times on no-match with a user sample", async () => {
		setProfiles(1);
		// The rule never matches the sample ("xyz" contains none of the chars).
		assistMock.mockImplementation(async () => ({ draft: zwspDraft() }));
		const { baseElement, getByText } = render(<Harness onApply={() => {}} />);
		const areas = baseElement.querySelectorAll("textarea");
		await act(async () => {
			await typeInto(areas[0]!, "убрать невидимые символы");
			await typeInto(areas[1]!, "xyz");
		});
		await act(async () => {
			fireEvent.click(getByText("regexAssistant.generate"));
		});
		// 1 manual + 2 auto refines — then the loop stops (≤2 bound).
		await waitFor(() => expect(assistMock.mock.calls.length).toBe(3), { timeout: 5000 });
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		expect(assistMock.mock.calls.length).toBe(3);
		// Refinement turns carry the test context explicitly.
		const second = assistMock.mock.calls[1]![0] as { previousAttempt?: { testResult: string } };
		expect(second.previousAttempt?.testResult).toContain("no match");
	});
});
