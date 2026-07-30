/**
 * generation-feedback — tests for the shared AI-generation feedback primitives.
 *
 * Covers the three exports extracted from AvatarDescriptionField:
 *   - useGenerationTask: re-entry guard, abort path, error funnel
 *   - GenerateCancelButton: label/title/icon wiring, morph rail layout
 *   - GenerationSurface: render-prop disabled, result-flash detection,
 *     generating overlay (spinner + label + backdrop-blur variant)
 *
 * Presentational-only contract: no i18n / stores / RPC / sonner imports here.
 * Strings arrive as props. The test harness composes the hook + button +
 * surface directly so each concern is exercised independently.
 *
 * Runner: bun:test with the scoped happy-dom harness.
 */
import { describe, it, expect, jest, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let useGenerationTask: typeof import("./generation-feedback.js").useGenerationTask;
let GenerateCancelButton: typeof import("./generation-feedback.js").GenerateCancelButton;
let GenerationSurface: typeof import("./generation-feedback.js").GenerationSurface;
beforeAll(async () => {
	({ useGenerationTask, GenerateCancelButton, GenerationSurface } = await import("./generation-feedback.js"));
});

/** Deferred promise — parks the hook mid-generation so cancel/abort paths
 *  can be observed deterministically without resolving the underlying work. */
function deferred<T = void>() {
	let resolve!: (v: T | PromiseLike<T>) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	mock.clearAllMocks();
});

// ---------------------------------------------------------------------------
// useGenerationTask
// ---------------------------------------------------------------------------

/** Harness that exposes start/cancel/generating through real buttons so
 *  fireEvent can drive them — mirrors how a consuming component wires them. */
function TaskHarness({
	onGenerate,
	onError,
}: {
	onGenerate: (signal: AbortSignal) => Promise<void>;
	onError?: (e: unknown) => void;
}) {
	const { generating, start, cancel } = useGenerationTask({ onGenerate, onError });
	return (
		<>
			<button onClick={start}>start</button>
			<button onClick={cancel}>cancel</button>
			<span data-testid="state">{generating ? "GEN" : "IDLE"}</span>
		</>
	);
}

describe("useGenerationTask", () => {
	it("idle → generating → cancel: signal is aborted; onError NOT called", async () => {
		const { promise } = deferred();
		const onGenerate = mock<(signal: AbortSignal) => Promise<void>>(() => promise);
		const onError = mock();
		const { getByText, getByTestId } = render(
			<TaskHarness onGenerate={onGenerate} onError={onError} />,
		);

		expect(getByTestId("state").textContent).toBe("IDLE");
		fireEvent.click(getByText("start"));
		await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
		expect(getByTestId("state").textContent).toBe("GEN");

		const signal = onGenerate.mock.calls[0]![0];
		expect(signal).toBeInstanceOf(AbortSignal);

		fireEvent.click(getByText("cancel"));
		expect(signal.aborted).toBe(true);
		expect(onError).not.toHaveBeenCalled();
	});

	it("onGenerate rejects (non-abort) → onError called with the error", async () => {
		const onGenerate = mock<() => Promise<void>>(() => Promise.reject(new Error("boom")));
		const onError = mock();
		const { getByText } = render(<TaskHarness onGenerate={onGenerate} onError={onError} />);

		fireEvent.click(getByText("start"));
		await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
	});

	it("re-entry guard: a second start() while generating does NOT call onGenerate again", async () => {
		const { promise } = deferred();
		const onGenerate = mock<(signal: AbortSignal) => Promise<void>>(() => promise);
		const { getByText } = render(<TaskHarness onGenerate={onGenerate} />);

		fireEvent.click(getByText("start"));
		await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));

		// Second start while still generating — must be a no-op.
		fireEvent.click(getByText("start"));
		fireEvent.click(getByText("start"));
		expect(onGenerate).toHaveBeenCalledTimes(1);
	});

	it("cancel() is a no-op when idle (no controller to abort)", () => {
		const onGenerate = mock();
		const { getByText } = render(<TaskHarness onGenerate={onGenerate} />);
		// Should not throw.
		expect(() => fireEvent.click(getByText("cancel"))).not.toThrow();
		expect(onGenerate).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// GenerateCancelButton
// ---------------------------------------------------------------------------

describe("GenerateCancelButton", () => {
	const labels = { generate: "GEN", regenerate: "REGEN", cancel: "CANCEL" };

	it("shows the generate label when hasValue=false", () => {
		const { getByText, queryByText } = render(
			<GenerateCancelButton
				generating={false}
				hasValue={false}
				labels={labels}
				onGenerate={mock()}
				onCancel={mock()}
			/>,
		);
		expect(getByText("GEN")).not.toBeNull();
		expect(queryByText("REGEN")).toBeNull();
	});

	it("shows the regenerate label when hasValue=true", () => {
		const { getByText, queryByText } = render(
			<GenerateCancelButton
				generating={false}
				hasValue={true}
				labels={labels}
				onGenerate={mock()}
				onCancel={mock()}
			/>,
		);
		expect(getByText("REGEN")).not.toBeNull();
		expect(queryByText("GEN")).toBeNull();
	});

	it("shows the cancel label while generating", () => {
		const { getByText, queryByText } = render(
			<GenerateCancelButton
				generating={true}
				hasValue={false}
				labels={labels}
				onGenerate={mock()}
				onCancel={mock()}
			/>,
		);
		expect(getByText("CANCEL")).not.toBeNull();
		expect(queryByText("GEN")).toBeNull();
	});

	it("clicking generate fires onGenerate; clicking cancel fires onCancel", () => {
		const onGenerate = mock();
		const onCancel = mock();
		const { getByText, rerender } = render(
			<GenerateCancelButton
				generating={false}
				hasValue={false}
				labels={labels}
				onGenerate={onGenerate}
				onCancel={onCancel}
			/>,
		);
		fireEvent.click(getByText("GEN"));
		expect(onGenerate).toHaveBeenCalledTimes(1);

		rerender(
			<GenerateCancelButton
				generating={true}
				hasValue={false}
				labels={labels}
				onGenerate={onGenerate}
				onCancel={onCancel}
			/>,
		);
		fireEvent.click(getByText("CANCEL"));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("disables the generate button when disabled=true (idle)", () => {
		const { getByText } = render(
			<GenerateCancelButton
				generating={false}
				hasValue={false}
				labels={labels}
				onGenerate={mock()}
				onCancel={mock()}
				disabled={true}
			/>,
		);
		expect(getByText("GEN").closest("button")!.disabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// GenerationSurface
// ---------------------------------------------------------------------------

/** Surface harness driven by the hook so the generating flag flows end-to-end. */
function SurfaceHarness({
	value = "",
	generatingLabel = "WORKING",
	disabled,
	hasExistingValue,
}: {
	value?: string;
	generatingLabel?: string;
	disabled?: boolean;
	hasExistingValue?: boolean;
}) {
	const { generating, start } = useGenerationTask({ onGenerate: () => new Promise<void>(() => {}) });
	return (
		<GenerationSurface
			generating={generating}
			value={value}
			generatingLabel={generatingLabel}
			disabled={disabled}
			{...(hasExistingValue !== undefined ? { hasExistingValue } : {})}
		>
			{({ disabled: childDisabled, controlClassName }) => (
				<>
					<button onClick={start}>go</button>
					<textarea data-testid="ctrl" disabled={childDisabled} className={controlClassName} />
				</>
			)}
		</GenerationSurface>
	);
}

describe("GenerationSurface", () => {
	it("generating → generatingLabel appears and child control becomes disabled", async () => {
		const { getByText, getByTestId } = render(<SurfaceHarness />);
		expect((getByTestId("ctrl") as HTMLTextAreaElement).disabled).toBe(false);
		fireEvent.click(getByText("go"));
		await waitFor(() => expect(getByText("WORKING")).not.toBeNull());
		expect((getByTestId("ctrl") as HTMLTextAreaElement).disabled).toBe(true);
	});

	it("mounts with existing content → NO result-flash overlay", () => {
		const { container } = render(<SurfaceHarness value="already here" />);
		expect(container.querySelector('[class*="bg-accent/10"]')).toBeNull();
	});

	it("empty → non-empty value transition while idle triggers the bg-accent/10 flash overlay, then clears", async () => {
		jest.useFakeTimers();
		try {
			const { rerender, container } = render(<SurfaceHarness value="" />);
			expect(container.querySelector('[class*="bg-accent/10"]')).toBeNull();

			rerender(<SurfaceHarness value="fresh" />);
			expect(container.querySelector('[class*="bg-accent/10"]')).not.toBeNull();

			act(() => {
				jest.advanceTimersByTime(1500);
			});
			expect(container.querySelector('[class*="bg-accent/10"]')).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});

	it("backdrop-blur variant is present only when committed value is non-empty", () => {
		const { container, rerender } = render(<SurfaceHarness value="" />);
		// Mount with empty value + idle: no generating overlay at all.
		expect(container.querySelector('[class*="backdrop-blur"]')).toBeNull();

		// Force a generating state by mounting with value present + a hook that
		// starts generating. We use a dedicated harness because SurfaceHarness
		// parks in pending; instead drive generating directly via the prop.
		function StaticGenerating({ value }: { value: string }) {
			return (
				<GenerationSurface generating={true} value={value} generatingLabel="WORKING">
					{() => <textarea />}
				</GenerationSurface>
			);
		}
		const sub = render(<StaticGenerating value="" />);
		expect(sub.container.querySelector('[class*="backdrop-blur"]')).toBeNull();
		sub.rerender(<StaticGenerating value="content" />);
		expect(sub.container.querySelector('[class*="backdrop-blur"]')).not.toBeNull();

		// Reference `rerender` so lint doesn't flag it unused (the outer harness
		// rerender is exercised above; the sub harness covers the blur variant).
		void rerender;
	});

	it("hasExistingValue override controls blur independently of value", () => {
		function H({ hasExisting }: { hasExisting: boolean }) {
			return (
				<GenerationSurface
					generating={true}
					value=""
					generatingLabel="WORKING"
					hasExistingValue={hasExisting}
				>
					{() => <textarea />}
				</GenerationSurface>
			);
		}
		const { container, rerender } = render(<H hasExisting={false} />);
		expect(container.querySelector('[class*="backdrop-blur"]')).toBeNull();
		rerender(<H hasExisting={true} />);
		expect(container.querySelector('[class*="backdrop-blur"]')).not.toBeNull();
	});

	it("disabled prop propagates to child control (external disable)", () => {
		const { getByTestId } = render(<SurfaceHarness disabled={true} />);
		expect((getByTestId("ctrl") as HTMLTextAreaElement).disabled).toBe(true);
	});

	it("controlClassName carries the transition token (and flash ring when flashing)", async () => {
		jest.useFakeTimers();
		try {
			const { container, rerender } = render(<SurfaceHarness value="" />);
			const ctrl = container.querySelector<HTMLTextAreaElement>('[data-testid="ctrl"]')!;
			expect(ctrl.className).toContain("transition-[border-color,box-shadow]");
			expect(ctrl.className).not.toContain("border-accent/60");

			rerender(<SurfaceHarness value="x" />);
			const ctrl2 = container.querySelector<HTMLTextAreaElement>('[data-testid="ctrl"]')!;
			expect(ctrl2.className).toContain("border-accent/60");
			expect(ctrl2.className).toContain("shadow-[0_0_0_2px_var(--accent-dim)]");

			await act(async () => {
				jest.advanceTimersByTime(1500);
			});
			const ctrl3 = container.querySelector<HTMLTextAreaElement>('[data-testid="ctrl"]')!;
			expect(ctrl3.className).not.toContain("border-accent/60");
		} finally {
			jest.useRealTimers();
		}
	});
});
