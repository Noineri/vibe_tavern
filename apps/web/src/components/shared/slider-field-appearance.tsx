import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "../../lib/cn.js";
import { inputCls, lblCls } from "../../lib/field-tokens.js";
import { SliderFieldEditor } from "./slider-field-editor.js";
import { clamp, formatFieldNumber, grabRange, snap, valueAt } from "./slider-field-math.js";
import type { SliderProps, SliderValue } from "./slider.js";

type GestureMode = "single" | "window";
type Gesture = {
	pointerId: number;
	startX: number;
	startY: number;
	mode: GestureMode;
	index: number;
	offset: number;
	changed: boolean;
	direction: "pending" | "scrub" | "scroll";
	latest: number[];
};

type PointerUpdate = {
	values: number[];
	changed: boolean;
};

function toSliderValue(value: number | readonly number[]): SliderValue {
	return typeof value === "number" ? value : [value[0]!, value[1]!];
}

function inputTestIdAt(inputTestId: SliderProps["inputTestId"], index: number) {
	return typeof inputTestId === "string" ? inputTestId : inputTestId?.[index];
}

function valuesEqual(left: number[], right: number[]) {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function SliderFieldAppearance<Value extends SliderValue>(props: SliderProps<Value>) {
	const {
		value, min, max, step, onValueChange, onValueCommitted, disabled = false, formatValue, valueClassName, label, help,
		inputTestId, numberTestId, "aria-label": ariaLabel, getAriaLabel, className,
	} = props;
	const fieldRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);
	const gesture = useRef<Gesture | null>(null);
	const thumbInputs = useRef<(HTMLInputElement | null)[]>([]);
	const [editing, setEditing] = useState(false);
	const [labelAbove, setLabelAbove] = useState(false);
	const range = Array.isArray(value);
	const values = range ? value : [value];
	const safeSpan = max > min ? max - min : 0;
	const percent = (item: number) => safeSpan === 0 ? 0 : clamp(((item - min) / safeSpan) * 100, 0, 100);
	const first = values[0]!;
	const editorInitialValue = useRef(first);
	const last = values[values.length - 1]!;
	const valueText = formatValue ? formatValue(value) : range
		? `${formatFieldNumber(first, step)} – ${formatFieldNumber(last, step)}`
		: formatFieldNumber(first, step);

	useLayoutEffect(() => {
		if (!label) return;
		const check = () => {
			const field = fieldRef.current;
			const labelElement = labelRef.current;
			const valueElement = valueRef.current;
			if (!field || field.clientWidth <= 0 || !labelElement || !valueElement) return;
			setLabelAbove(labelElement.scrollWidth + valueElement.scrollWidth + 34 > field.clientWidth);
		};
		check();
		if (typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver(check);
		if (fieldRef.current) observer.observe(fieldRef.current);
		return () => observer.disconnect();
	}, [help, label, valueText, labelAbove]);

	useEffect(() => {
		if (disabled) setEditing(false);
	}, [disabled]);

	function focusThumb(index: number) {
		thumbInputs.current[index]?.focus({ preventScroll: true });
	}

	function emit(next: number[]) {
		onValueChange((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function commit(next: number[]) {
		onValueCommitted?.((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function setFromPointer(
		clientX: number,
		mode: GestureMode,
		index: number,
		offset: number,
		current: number[],
	): PointerUpdate {
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return { values: current, changed: false };
		const next = current.slice();
		const point = valueAt(clientX, rect, min, max, step, current[index] ?? current[0]!);
		if (mode === "window" && range) {
			const width = last - first;
			const start = clamp(point - offset, min, max - width);
			next[0] = snap(start, min, max, step);
			next[1] = snap(start + width, min, max, step);
		} else if (range) {
			next[index] = index === 0 ? Math.min(point, next[1]!) : Math.max(point, next[0]!);
		} else {
			next[0] = point;
		}
		if (valuesEqual(next, current)) return { values: current, changed: false };
		emit(next);
		return { values: next, changed: true };
	}

	function clearGesture(event?: PointerEvent<HTMLDivElement>) {
		if (event && fieldRef.current?.hasPointerCapture(event.pointerId)) fieldRef.current.releasePointerCapture(event.pointerId);
		gesture.current = null;
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		const target = event.target;
		if (
			disabled
			|| editing
			|| event.button > 0
			|| (target instanceof Element && target.closest("input,button,a,[data-slider-field-help]"))
		) return;
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return;
		const point = valueAt(event.clientX, rect, min, max, step, first);
		let mode: GestureMode = "single";
		let index = 0;
		if (range) {
			const grab = grabRange(point, first, last, step);
			if (grab.window) mode = "window";
			index = grab.index;
		}
		gesture.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			mode,
			index,
			offset: point - first,
			changed: false,
			direction: event.pointerType === "touch" ? "pending" : "scrub",
			latest: values.slice(),
		};
		if (event.pointerType !== "touch") {
			fieldRef.current?.setPointerCapture(event.pointerId);
			const update = setFromPointer(event.clientX, mode, index, point - first, gesture.current.latest);
			gesture.current.latest = update.values;
			gesture.current.changed = update.changed;
		}
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId || current.direction === "scroll") return;
		if (current.direction === "pending") {
			const deltaX = Math.abs(event.clientX - current.startX);
			const deltaY = Math.abs(event.clientY - current.startY);
			if (Math.max(deltaX, deltaY) < 4) return;
			if (deltaY > deltaX) {
				current.direction = "scroll";
				return;
			}
			current.direction = "scrub";
			fieldRef.current?.setPointerCapture(event.pointerId);
		}
		const update = setFromPointer(event.clientX, current.mode, current.index, current.offset, current.latest);
		current.latest = update.values;
		current.changed ||= update.changed;
	}

	function onPointerUp(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		if (current.direction === "pending") {
			const update = setFromPointer(event.clientX, current.mode, current.index, current.offset, current.latest);
			current.latest = update.values;
			current.changed ||= update.changed;
		}
		if (current.direction !== "scroll" && current.changed) commit(current.latest);
		// A mouse or pen press leaves keyboard focus on the field, as a native slider does.
		if (current.direction !== "scroll" && event.pointerType !== "touch") focusThumb(current.index);
		clearGesture(event);
	}

	function openEditor() {
		if (disabled || range || editing) return;
		editorInitialValue.current = first;
		setEditing(true);
	}

	function finishEditor(next: number | null, restoreFocus: boolean) {
		setEditing(false);
		if (next !== null && next !== editorInitialValue.current && !disabled) {
			onValueChange(next as Value);
			onValueCommitted?.(next as Value);
		}
		if (restoreFocus) focusThumb(0);
	}

	return (
		<div
			data-slider-field-shell
			className={cn("relative min-w-0", disabled && "pointer-events-none opacity-40", className)}
		>
			<span
				aria-hidden
				ref={valueRef}
				data-slider-field-measure-value
				className="pointer-events-none invisible absolute whitespace-nowrap font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums"
			>
				{valueText}
			</span>
			{label && (
				<span
					data-slider-field-label={labelAbove ? undefined : ""}
					data-slider-field-label-above={labelAbove ? "" : undefined}
					className={cn(
						labelAbove
							? lblCls
							: "pointer-events-none absolute left-[13px] top-0 z-[1] flex h-11 items-center sm:h-[38px]",
					)}
				>
					<span
						ref={labelRef}
						data-slider-field-label-content
						className="inline-flex w-max items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3"
					>
						<span>{label}</span>
						{help && <span data-slider-field-help className="pointer-events-auto inline-flex">{help}</span>}
					</span>
				</span>
			)}
			<BaseSlider.Root
				data-slider-root
				value={value}
				min={min}
				max={max}
				step={step}
				largeStep={Number.isFinite(step) && step > 0 ? step * 10 : undefined}
				disabled={disabled}
				thumbCollisionBehavior={range ? "none" : undefined}
				onValueChange={(next) => {
					if (!disabled) onValueChange(toSliderValue(next) as Value);
				}}
				onValueCommitted={onValueCommitted ? (next) => {
					if (!disabled) onValueCommitted(toSliderValue(next) as Value);
				} : undefined}
				className="contents"
			>
				<BaseSlider.Control
					data-slider-field-input-control
					className="peer pointer-events-none absolute inset-0 opacity-0"
				>
					<BaseSlider.Track>
						<BaseSlider.Indicator />
					</BaseSlider.Track>
					{values.map((_, index) => {
						const testId = inputTestIdAt(inputTestId, index);
						return (
							<BaseSlider.Thumb
								key={index}
								index={range ? index : undefined}
								aria-label={range ? undefined : ariaLabel}
								getAriaLabel={range ? getAriaLabel : undefined}
								inputRef={(input) => {
									thumbInputs.current[index] = input;
									if (input && testId) input.dataset.testid = testId;
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										openEditor();
									}
								}}
							/>
						);
					})}
				</BaseSlider.Control>
				<div
					ref={fieldRef}
					data-slider-field
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={clearGesture}
					onLostPointerCapture={clearGesture}
					onDoubleClick={openEditor}
					className={cn(inputCls, "relative isolate block cursor-ew-resize select-none overflow-hidden p-0 touch-pan-y peer-has-[input:focus-visible]:border-accent", editing && "cursor-text")}
				>
					<span
						data-slider-field-fill
						className={cn(
							// Translucent whatever the theme: several themes define --accent-hover as an opaque color, which would bury the text.
							"pointer-events-none absolute inset-y-0 left-0 z-0 bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]",
							percent(first) > 0 && !range && "border-r-2 border-accent",
						)}
						style={{
							width: `${range ? percent(last) - percent(first) : percent(first)}%`,
							left: range ? `${percent(first)}%` : undefined,
						}}
					/>
					{range && values.map((item, index) => (
						<span
							key={index}
							data-slider-field-handle
							className="pointer-events-none absolute top-[7px] bottom-[7px] z-[1] w-[3px] -translate-x-1/2 rounded-sm bg-accent"
							style={{ left: `${percent(item)}%` }}
						/>
					))}
					{editing ? (
						<SliderFieldEditor
							initial={first}
							min={min}
							max={max}
							step={step}
							testId={numberTestId}
							onFinish={finishEditor}
						/>
					) : (
						<span
							data-slider-field-value
							className={cn("pointer-events-none absolute right-[13px] top-0 z-[1] flex h-full items-center font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums", valueClassName ?? "text-t1")}
						>
							{valueText}
						</span>
					)}
				</div>
			</BaseSlider.Root>
		</div>
	);
}
