import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "../../lib/cn.js";
import { inputCls, lblCls } from "../../lib/field-tokens.js";
import type { SliderProps, SliderValue } from "./slider.js";

type GestureMode = "single" | "edge" | "window";
type Gesture = {
	pointerId: number;
	startX: number;
	startY: number;
	type: string;
	mode: GestureMode;
	index: number;
	offset: number;
	changed: boolean;
	direction: "pending" | "scrub" | "scroll";
	latest: number[];
};

function decimals(step: number) {
	const text = String(step);
	return Number.isFinite(step) && step > 0 && text.includes(".") ? text.split(".")[1]!.length : 0;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function snap(value: number, min: number, max: number, step: number) {
	const bounded = clamp(value, min, max);
	return Number.isFinite(step) && step > 0
		? clamp(Math.round((bounded - min) / step) * step + min, min, max)
		: bounded;
}

function valueAt(clientX: number, rect: DOMRect, min: number, max: number, step: number, fallback: number) {
	if (!Number.isFinite(clientX) || !Number.isFinite(rect.width) || rect.width <= 0 || max <= min) return fallback;
	return snap(min + ((clientX - rect.left) / rect.width) * (max - min), min, max, step);
}

function toSliderValue(value: number | readonly number[]): SliderValue {
	return typeof value === "number" ? value : [value[0]!, value[1]!];
}

function inputTestIdAt(inputTestId: SliderProps["inputTestId"], index: number) {
	return typeof inputTestId === "string" ? inputTestId : inputTestId?.[index];
}

export function SliderFieldAppearance<Value extends SliderValue>(props: SliderProps<Value>) {
	const {
		value, min, max, step, onValueChange, onValueCommitted, disabled = false, formatValue, label, help,
		inputTestId, numberTestId, "aria-label": ariaLabel, getAriaLabel, className,
	} = props;
	const fieldRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);
	const gesture = useRef<Gesture | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [labelAbove, setLabelAbove] = useState(false);
	const range = Array.isArray(value);
	const values = range ? value : [value];
	// Base UI renders thumb positions from its bounds. Keep its hidden geometry finite
	// for the existing single-message range while the field itself remains pinned.
	const baseMax = max > min ? max : min + (Number.isFinite(step) && step > 0 ? step : 1);
	const safeSpan = max > min ? max - min : 0;
	const percent = (item: number) => safeSpan === 0 ? 0 : clamp(((item - min) / safeSpan) * 100, 0, 100);
	const first = values[0]!;
	const last = values[values.length - 1]!;
	const valueText = formatValue ? formatValue(value) : range
		? `${first.toFixed(decimals(step))} – ${last.toFixed(decimals(step))}`
		: first.toFixed(decimals(step));

	useLayoutEffect(() => {
		if (!label) return;
		const check = () => {
			const field = fieldRef.current;
			const labelElement = labelRef.current;
			const valueElement = valueRef.current;
			if (!field || !labelElement || !valueElement) return;
			setLabelAbove(labelElement.scrollWidth + valueElement.scrollWidth + 34 > field.clientWidth);
		};
		check();
		const observer = new ResizeObserver(check);
		if (fieldRef.current) observer.observe(fieldRef.current);
		return () => observer.disconnect();
	}, [label, valueText, labelAbove]);

	function emit(next: number[]) {
		onValueChange((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function commit(next: number[]) {
		onValueCommitted?.((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function setFromPointer(clientX: number, mode: GestureMode, index: number, offset: number, current: number[]) {
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return current;
		const next = current.slice();
		const point = valueAt(clientX, rect, min, max, step, current[index] ?? current[0]!);
		if (mode === "window" && range) {
			const width = last - first;
			const start = clamp(point - offset, min, max - width);
			next[0] = start;
			next[1] = start + width;
		} else if (range) {
			next[index] = index === 0 ? Math.min(point, next[1]!) : Math.max(point, next[0]!);
		} else {
			next[0] = point;
		}
		emit(next);
		return next;
	}

	function clearGesture(event?: PointerEvent<HTMLDivElement>) {
		if (event && fieldRef.current?.hasPointerCapture(event.pointerId)) fieldRef.current.releasePointerCapture(event.pointerId);
		gesture.current = null;
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (disabled || editing || event.button > 0 || (event.target as HTMLElement).closest("input,button,a")) return;
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return;
		const point = valueAt(event.clientX, rect, min, max, step, first);
		let mode: GestureMode = "single";
		let index = 0;
		if (range) {
			const firstDistance = Math.abs(point - first);
			const lastDistance = Math.abs(point - last);
			if (point > first && point < last && firstDistance > step && lastDistance > step) mode = "window";
			else index = firstDistance <= lastDistance ? 0 : 1;
		}
		gesture.current = {
			pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, type: event.pointerType,
			mode, index, offset: point - first, changed: false, direction: event.pointerType === "touch" ? "pending" : "scrub", latest: values.slice(),
		};
		if (event.pointerType !== "touch") {
			fieldRef.current?.setPointerCapture(event.pointerId);
			gesture.current.latest = setFromPointer(event.clientX, mode, index, point - first, gesture.current.latest);
			gesture.current.changed = true;
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
		current.changed = true;
		current.latest = setFromPointer(event.clientX, current.mode, current.index, current.offset, current.latest);
	}

	function onPointerUp(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		if (current.direction === "pending") {
			current.latest = setFromPointer(event.clientX, current.mode, current.index, current.offset, current.latest);
			current.changed = true;
		}
		if (current.direction === "scrub" || current.changed) commit(current.latest);
		clearGesture(event);
	}

	function openEditor() {
		if (disabled || range) return;
		setDraft(first.toFixed(decimals(step)));
		setEditing(true);
	}

	function finishEditor(save: boolean) {
		if (!editing) return;
		setEditing(false);
		const parsed = Number(draft);
		if (save && Number.isFinite(parsed)) {
			const next = snap(parsed, min, max, step);
			onValueChange(next as Value);
			onValueCommitted?.(next as Value);
		}
	}

	return (
		<div className={cn("relative min-w-0", className)}>
			{label && <span aria-hidden ref={labelRef} data-slider-field-measure-label className="invisible absolute whitespace-nowrap">{label}</span>}
			<span aria-hidden ref={valueRef} data-slider-field-measure-value className="invisible absolute whitespace-nowrap font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums">{valueText}</span>
			{label && labelAbove && <span data-slider-field-label-above className={lblCls}>{label}{help}</span>}
			<BaseSlider.Root
				data-slider-root
				value={value}
				min={min}
				max={baseMax}
				step={step}
				largeStep={Number.isFinite(step) && step > 0 ? step * 10 : step}
				disabled={disabled}
				thumbCollisionBehavior={range ? "none" : undefined}
				onValueChange={(next) => { if (!disabled) onValueChange(toSliderValue(next) as Value); }}
				onValueCommitted={onValueCommitted ? (next) => { if (!disabled) onValueCommitted(toSliderValue(next) as Value); } : undefined}
				className="contents"
			>
				<BaseSlider.Control className="peer pointer-events-none absolute inset-0 opacity-0">
					<BaseSlider.Track><BaseSlider.Indicator /></BaseSlider.Track>
					{values.map((_, index) => {
						const testId = inputTestIdAt(inputTestId, index);
						return <BaseSlider.Thumb key={index} index={range ? index : undefined} aria-label={range ? undefined : ariaLabel} getAriaLabel={range ? getAriaLabel : undefined} inputRef={(input) => { if (input && testId) input.dataset.testid = testId; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openEditor(); } }} />;
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
					className={cn(inputCls, "relative block cursor-ew-resize select-none overflow-hidden p-0 touch-pan-y peer-has-[input:focus-visible]:border-accent", editing && "cursor-text", disabled && "pointer-events-none opacity-40")}
				>
					<span data-slider-field-fill className={cn("pointer-events-none absolute inset-y-0 left-0 bg-accent-hover", percent(first) > 0 && !range && "border-r-2 border-accent")} style={{ width: `${range ? percent(last) - percent(first) : percent(first)}%`, left: range ? `${percent(first)}%` : undefined }} />
					{range && values.map((item, index) => <span key={index} data-slider-field-handle className="pointer-events-none absolute top-[7px] bottom-[7px] z-[1] w-[3px] -translate-x-1/2 rounded-sm bg-accent" style={{ left: `${percent(item)}%` }} />)}
					{label && !labelAbove && <span data-slider-field-label className="pointer-events-none absolute left-[13px] top-0 flex h-full items-center gap-1 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{label}{help}</span>}
					{editing ? <input autoFocus data-testid={numberTestId} type="number" min={min} max={max} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") finishEditor(true); if (event.key === "Escape") finishEditor(false); event.stopPropagation(); }} onBlur={() => finishEditor(true)} className="absolute right-1 top-1 bottom-1 w-[76px] rounded-[5px] border border-accent bg-s1 px-2 text-right font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none" /> : <span data-slider-field-value className="pointer-events-none absolute right-[13px] top-0 flex h-full items-center font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums text-t1">{valueText}</span>}
				</div>
			</BaseSlider.Root>
		</div>
	);
}
