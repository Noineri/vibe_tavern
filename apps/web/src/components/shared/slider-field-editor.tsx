import { useRef, useState, type FocusEvent } from "react";
import { NumberInput } from "./NumberInput.js";
import { snap } from "./slider-field-math.js";

export interface SliderFieldEditorProps {
	initial: number;
	min: number;
	max: number;
	step: number;
	testId?: string;
	/**
	 * Called exactly once per editor lifetime.
	 * `value` is the clamped and step-snapped result, or `null` when the edit was cancelled.
	 * `restoreFocus` is false when focus is already moving to another control (blur by click or Tab).
	 */
	onFinish: (value: number | null, restoreFocus: boolean) => void;
}

/**
 * Inline number editor of the slider field, rendered at the value's place.
 * Enter or blur commits, Escape cancels; text entry, clamping to the bounds and the stepper keys come from `NumberInput`.
 * A ref guard (not state) makes a second finish impossible: Enter blurs the input, and unmounting can blur it again.
 */
export function SliderFieldEditor({ initial, min, max, step, testId, onFinish }: SliderFieldEditorProps) {
	const [draft, setDraft] = useState(initial);
	const draftRef = useRef(initial);
	const finished = useRef(false);

	function finish(save: boolean, restoreFocus: boolean) {
		if (finished.current) return;
		finished.current = true;
		onFinish(save ? snap(draftRef.current, min, max, step) : null, restoreFocus);
	}

	return (
		<div
			data-slider-field-editor
			className="absolute inset-y-1 right-1 w-[76px]"
			onKeyDown={(event) => event.stopPropagation()}
		>
			<NumberInput
				autoFocus
				hideControls
				value={draft}
				min={min}
				max={max}
				step={step}
				inputTestId={testId}
				onChange={(next) => {
					draftRef.current = next;
					setDraft(next);
				}}
				onBlur={(event: FocusEvent<HTMLInputElement>) => finish(true, event.relatedTarget === null)}
				onEscape={() => finish(false, true)}
				className="!h-full w-full !border-accent !bg-s1"
				inputClassName="!px-2 !text-right !text-[calc(var(--ui-fs)-1px)]"
			/>
		</div>
	);
}
