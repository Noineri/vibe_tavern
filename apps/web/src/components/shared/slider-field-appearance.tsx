import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "../../lib/cn.js";
import { inputCls, lblCls } from "../../lib/field-tokens.js";
import type { SliderProps, SliderValue } from "./slider.js";

function decimals(step: number) {
	const text = String(step);
	return text.includes(".") ? text.split(".")[1]!.length : 0;
}

function snap(value: number, min: number, max: number, step: number) {
	return Math.min(max, Math.max(min, Math.round((value - min) / step) * step + min));
}

function valueAt(clientX: number, rect: DOMRect, min: number, max: number, step: number) {
	return snap(min + ((clientX - rect.left) / rect.width) * (max - min), min, max, step);
}

function display(value: number, step: number, formatValue?: (value: number) => string) {
	return formatValue ? formatValue(value) : value.toFixed(decimals(step));
}

function toSliderValue(value: number | readonly number[]): SliderValue {
	return typeof value === "number" ? value : [value[0]!, value[1]!];
}

function inputTestIdAt(inputTestId: SliderProps["inputTestId"], index: number) {
	return typeof inputTestId === "string" ? inputTestId : inputTestId?.[index];
}

export function SliderFieldAppearance<Value extends SliderValue>({
	value, min, max, step, onValueChange, onValueCommitted, disabled = false, formatValue, label, help, inputTestId,
	numberTestId, "aria-label": ariaLabel, getAriaLabel, className,
}: SliderProps<Value>) {
	const fieldRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);
	const gesture = useRef<{ pointerId: number; startX: number; type: "mouse" | "touch"; mode: "single" | "edge" | "window"; index: number; offset: number; changed: boolean } | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [labelAbove, setLabelAbove] = useState(false);
	const range = Array.isArray(value);
	const values = range ? value : [value];
	const percent = (item: number) => ((item - min) / (max - min)) * 100;
	const first = values[0]!;
	const last = values[values.length - 1]!;
	const valueText = range ? `${display(first, step, formatValue)} – ${display(last, step, formatValue)}` : display(first, step, formatValue);

	useLayoutEffect(() => {
		if (!label || !fieldRef.current || !labelRef.current || !valueRef.current) return;
		const check = () => setLabelAbove(labelRef.current!.scrollWidth + valueRef.current!.scrollWidth + 34 > fieldRef.current!.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(fieldRef.current);
		return () => observer.disconnect();
	}, [label, valueText]);

	function emit(next: number[]) {
		onValueChange((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function commit(next: number[]) {
		onValueCommitted?.((range ? [next[0]!, next[1]!] : next[0]!) as Value);
	}

	function setFromPointer(clientX: number, mode: "single" | "edge" | "window", index: number, offset: number) {
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return values.slice();
		const next = values.slice();
		const point = valueAt(clientX, rect, min, max, step);
		if (mode === "window") {
			const width = last - first;
			const start = Math.min(max - width, Math.max(min, point - offset));
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

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (disabled || editing || event.button > 0 || (event.target as HTMLElement).closest("input,button,a")) return;
		event.stopPropagation();
		const rect = fieldRef.current?.getBoundingClientRect();
		if (!rect) return;
		const point = valueAt(event.clientX, rect, min, max, step);
		let mode: "single" | "edge" | "window" = "single";
		let index = 0;
		if (range) {
			const distanceFirst = Math.abs(point - first);
			const distanceLast = Math.abs(point - last);
			if (point > first && point < last && distanceFirst > step && distanceLast > step) mode = "window";
			else index = distanceFirst <= distanceLast ? 0 : 1;
		}
		gesture.current = { pointerId: event.pointerId, startX: event.clientX, type: event.pointerType === "mouse" ? "mouse" : "touch", mode, index, offset: point - first, changed: false };
		fieldRef.current?.setPointerCapture(event.pointerId);
		if (event.pointerType === "mouse") {
			setFromPointer(event.clientX, mode, index, point - first);
			gesture.current.changed = true;
		}
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		if (current.type === "touch" && Math.abs(event.clientX - current.startX) < 4) return;
		current.changed = true;
		setFromPointer(event.clientX, current.mode, current.index, current.offset);
	}

	function onPointerUp(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		const next = current.type === "touch" && !current.changed
			? setFromPointer(event.clientX, current.mode, current.index, current.offset)
			: values.slice();
		if (current.changed || current.type === "touch") commit(next);
		gesture.current = null;
	}

	function openEditor() {
		if (disabled || range) return;
		setDraft(display(first, step));
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
		<div className={cn("min-w-0", className)}>
			{label && labelAbove && <span data-slider-field-label-above className={lblCls}>{label}</span>}
			<BaseSlider.Root data-slider-root value={value} min={min} max={max} step={step} disabled={disabled} thumbCollisionBehavior={range ? "none" : undefined} onValueChange={(next) => { if (!disabled) onValueChange(toSliderValue(next) as Value); }} onValueCommitted={onValueCommitted ? (next) => { if (!disabled) onValueCommitted(toSliderValue(next) as Value); } : undefined} className="contents">
				<BaseSlider.Control
					ref={fieldRef} data-slider-field tabIndex={-1} onPointerDownCapture={onPointerDown} onPointerMoveCapture={onPointerMove} onPointerUpCapture={onPointerUp} onDoubleClick={openEditor}
					className={cn(inputCls, "relative block cursor-ew-resize select-none overflow-hidden p-0 touch-pan-y data-[disabled]:pointer-events-none data-[disabled]:opacity-40", editing && "cursor-text")}
				>
					<BaseSlider.Track data-slider-track className="absolute inset-0 overflow-visible bg-transparent">
						<BaseSlider.Indicator className="bg-accent-hover border-r-2 border-accent data-[orientation=horizontal]:h-full" />
					</BaseSlider.Track>
					{range && values.map((item, index) => <span key={index} data-slider-field-handle className="pointer-events-none absolute top-[7px] bottom-[7px] z-[1] w-[3px] -translate-x-1/2 rounded-sm bg-accent" style={{ left: `${percent(item)}%` }} />)}
					{label && !labelAbove && <span ref={labelRef} data-slider-field-label className="pointer-events-none absolute left-[13px] top-0 flex h-full items-center gap-1 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{label}{help}</span>}
					{editing ? <input autoFocus data-testid={numberTestId} type="number" min={min} max={max} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") finishEditor(true); if (event.key === "Escape") finishEditor(false); event.stopPropagation(); }} onBlur={() => finishEditor(true)} className="absolute right-1 top-1 bottom-1 w-[76px] rounded-[5px] border border-accent bg-s1 px-2 text-right font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none" /> : <span ref={valueRef} data-slider-field-value className="pointer-events-none absolute right-[13px] top-0 flex h-full items-center font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums text-t1">{valueText}</span>}
					{values.map((_, index) => {
						const testId = inputTestIdAt(inputTestId, index);
						return <BaseSlider.Thumb key={index} index={range ? index : undefined} aria-label={range ? undefined : ariaLabel} getAriaLabel={range ? getAriaLabel : undefined} inputRef={(input) => { if (input && testId) input.dataset.testid = testId; }} className="absolute opacity-0" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openEditor(); } }} />;
					})}
				</BaseSlider.Control>
			</BaseSlider.Root>
		</div>
	);
}
