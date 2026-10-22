/** Number of fraction digits needed to print `value` exactly (handles exponent notation such as 1e-7). */
export function decimals(value: number) {
	if (!Number.isFinite(value)) return 0;
	const [mantissa = "", exponent] = String(value).split("e");
	const fraction = (mantissa.split(".")[1] ?? "").length;
	const shift = exponent === undefined ? 0 : -Number(exponent);
	return Math.min(20, Math.max(0, fraction + shift));
}

export function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Snaps to the step grid anchored at `min`, bounded to [min, max].
 * The result is rounded to the grid's own precision so that step 0.05 yields 0.7, never 0.7000000000000001.
 */
export function snap(value: number, min: number, max: number, step: number) {
	const bounded = clamp(value, min, max);
	if (!(Number.isFinite(step) && step > 0)) return bounded;
	const precision = Math.max(decimals(step), decimals(min));
	const onGrid = Math.round((bounded - min) / step) * step + min;
	return clamp(Number(onGrid.toFixed(precision)), min, max);
}

/** Maps a pointer x-coordinate to a snapped value; returns `fallback` when the geometry is unusable. */
export function valueAt(clientX: number, rect: DOMRect, min: number, max: number, step: number, fallback: number) {
	if (!Number.isFinite(clientX) || !Number.isFinite(rect.width) || rect.width <= 0 || max <= min) return fallback;
	return snap(min + ((clientX - rect.left) / rect.width) * (max - min), min, max, step);
}

/**
 * Decides what a press at `point` grabs in a two-value field.
 * Strictly inside the window and more than one step from both edges: the whole window.
 * Otherwise the nearer edge handle; an exact tie (a collapsed pair) is settled by the pointer side, so the pair can open either way.
 * Distances are counted in whole steps, which keeps fractional steps free of floating-point noise.
 */
export function grabRange(point: number, first: number, last: number, step: number): { window: boolean; index: 0 | 1 } {
	const unit = Number.isFinite(step) && step > 0 ? step : 1;
	const fromFirst = Math.round((point - first) / unit);
	const fromLast = Math.round((last - point) / unit);
	if (fromFirst > 1 && fromLast > 1) return { window: true, index: 0 };
	const nearerFirst = Math.abs(fromFirst);
	const nearerLast = Math.abs(fromLast);
	if (nearerFirst !== nearerLast) return { window: false, index: nearerFirst < nearerLast ? 0 : 1 };
	return { window: false, index: point < first ? 0 : 1 };
}
