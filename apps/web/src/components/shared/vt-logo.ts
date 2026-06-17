/**
 * Vibe Tavern logo — canonical definition + inertial "chase-train" orbit motion.
 *
 * Source of truth for the {@link Logo} React component AND the standalone
 * server loading placeholder (which mirrors this math in vanilla JS — see
 * `services/api/src/server/loading-placeholder.ts`). The path data below is
 * lifted verbatim from the `vt_sign.svg` asset (1 open book + 3 four-point
 * stars); star natural centers are the bounding-box centers of each star path.
 *
 * ## Motion model (one cycle, `t` ∈ [0,1])
 *
 * The cycle has four phases (boundaries in {@link PHASE}):
 *   1. **rest**   — stars hold their natural logo pose (the recognizable mark).
 *   2. **rise**   — stars ease out to their starting slots on the orbit circle.
 *   3. **orbit**  — chase-train: all three follow each other around the book,
 *                   with **inertial** timing (slow at the apex, a gravity whip
 *                   through the bottom). One leader, two trailers.
 *   4. **return** — stars ease back into the natural logo pose.
 *
 * The loop is seamless: position at `t = 0` equals position at `t = 1`, and
 * velocity is continuous at every phase boundary (eases have zero derivative
 * at both ends). See {@link starPositionAt}.
 *
 * Inertia comes from {@link inertiaTurns}: angular speed `1 − A·cos(2π·N·u)`
 * is minimal at each loop's apex and maximal at its bottom — a pendulum/bowl
 * feel rather than a keyframe snap. `A` is the strength of the effect.
 *
 * Tuned values live in {@link MOTION_DEFAULTS}; do not hand-tune the math
 * constants here without re-running `vt-logo.test.ts`.
 */

/** The open-book path (static element). Lifted from `vt_sign.svg`. */
export const BOOK_PATH =
	"M228.277 60.5653L169.085 141.858L261.622 83.8188L269.364 96.163L176.183 154.606L281.244 126.197L285.047 140.264L159.958 174.088C158.598 165.58 151.226 159.078 142.334 159.078C133.476 159.078 126.127 165.53 124.726 173.99L0 140.264L3.80371 126.197L108.864 154.606L15.6831 96.163L23.4258 83.8188L115.962 141.858L56.7705 60.5653L68.5498 51.9882L142.523 153.582L216.498 51.9882L228.277 60.5653Z";

/**
 * The three stars: natural resting center (`cx`/`cy`, = the star path's
 * bounding-box center), chase `order` (0 = leads the train), and the path.
 * Order in the array is large → medium → tiny (matches `vt_sign.svg`).
 */
export interface StarDef {
	readonly cx: number;
	readonly cy: number;
	readonly order: number;
	readonly path: string;
}

export const STAR_DEFS: readonly StarDef[] = [
	{
		cx: 169.07,
		cy: 30.35,
		order: 0,
		path: "M165.904 2.23722C166.998 -0.68871 171.137 -0.68873 172.23 2.23722L178.572 19.1986C178.86 19.9707 179.422 20.6109 180.149 20.998L192.127 27.3681C194.515 28.6384 194.515 32.0607 192.127 33.331L180.149 39.7011C179.422 40.0881 178.86 40.7283 178.572 41.5004L172.23 58.4618C171.137 61.3878 166.998 61.3878 165.904 58.4618L159.563 41.5004C159.274 40.7283 158.713 40.0881 157.985 39.7011L146.008 33.331C143.62 32.0607 143.62 28.6384 146.008 27.3681L157.985 20.998C158.713 20.6109 159.274 19.9707 159.563 19.1986L165.904 2.23722Z",
	},
	{
		cx: 124.05,
		cy: 66.88,
		order: 1,
		path: "M122.963 49.1806C123.338 48.1762 124.759 48.1762 125.135 49.1806L129.501 60.8603C129.6 61.1253 129.793 61.3451 130.042 61.4779L138.271 65.8539C139.091 66.29 139.091 67.4652 138.271 67.9013L130.042 72.2777C129.793 72.4106 129.6 72.63 129.501 72.8949L125.135 84.5746C124.759 85.579 123.338 85.579 122.963 84.5746L118.597 72.8949C118.498 72.63 118.305 72.4106 118.055 72.2777L109.826 67.9013C109.006 67.4652 109.006 66.29 109.826 65.8539L118.055 61.4779C118.305 61.3451 118.498 61.1253 118.597 60.8603L122.963 49.1806Z",
	},
	{
		cx: 111.59,
		cy: 13.97,
		order: 2,
		path: "M110.472 0.778726C110.86 -0.259575 112.329 -0.259575 112.717 0.778726L115.842 9.1381C115.945 9.41208 116.144 9.63943 116.402 9.77677L122.297 12.912C123.145 13.3628 123.145 14.5775 122.297 15.0282L116.402 18.164C116.144 18.3013 115.945 18.5282 115.842 18.8022L112.717 27.1615C112.329 28.1998 110.86 28.1998 110.472 27.1615L107.347 18.8022C107.244 18.5282 107.045 18.3013 106.787 18.164L100.891 15.0282C100.044 14.5775 100.044 13.3628 100.891 12.912L106.787 9.77677C107.045 9.63942 107.244 9.41209 107.347 9.1381L110.472 0.778726Z",
	},
] as const;

/** Orbit center = book bounding-box center. Stars circle the book, clearing its pages. */
export const BOOK_CENTER = { x: 142.52, y: 113.04 } as const;

/**
 * Tuned motion parameters (approved via the interactive prototype).
 * See the module docstring for the meaning of each field.
 */
export interface MotionParams {
	/** Orbit radius in SVG units. */
	readonly radius: number;
	/** Full cycle duration in milliseconds. */
	readonly durationMs: number;
	/** Inertia strength A ∈ [0, ~0.95]: 0 = constant speed, higher = sharper bottom whip. */
	readonly inertia: number;
	/** Angular gap between chase-train stars, in degrees (tight = comet tail). */
	readonly chaseGapDeg: number;
	/** Number of full orbits per cycle. */
	readonly loops: number;
}

export const MOTION_DEFAULTS: MotionParams = {
	radius: 150,
	durationMs: 3200,
	inertia: 0.82,
	chaseGapDeg: 17,
	loops: 1,
};

/** Phase boundaries as a fraction of one cycle: rest → rise → orbit → return. */
export const PHASE = {
	restEnd: 0.08,
	riseEnd: 0.20,
	orbitEnd: 0.80,
} as const;

/** Symmetric ease in/out with zero derivative at both ends (smooth phase seams). */
function easeInOut(t: number, power: number): number {
	return t < 0.5 ? Math.pow(2 * t, power) / 2 : 1 - Math.pow(-2 * t + 2, power) / 2;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/**
 * Inertial angle mapping over the orbit phase. `u` ∈ [0,1] → turns ∈ [0, N].
 * Angular speed = d/du = `1 − A·cos(2π·N·u)`: minimal at each loop's apex,
 * maximal at its bottom — the pendulum "whip". Smooth and seamlessly periodic.
 */
export function inertiaTurns(u: number, inertia: number, loops: number): number {
	return u - (inertia * Math.sin(2 * Math.PI * loops * u)) / (2 * Math.PI * loops);
}

/** Position on the orbit circle. `thetaDeg`: 0 = top, clockwise. */
function orbitPos(thetaDeg: number, radius: number): { x: number; y: number } {
	const t = (thetaDeg * Math.PI) / 180;
	return { x: BOOK_CENTER.x + radius * Math.sin(t), y: BOOK_CENTER.y - radius * Math.cos(t) };
}

/**
 * SVG-space position of star `index` at cycle progress `t` ∈ [0,1].
 * Pure & deterministic — safe to call every animation frame.
 */
export function starPositionAt(
	t: number,
	index: number,
	params: MotionParams = MOTION_DEFAULTS,
): { x: number; y: number } {
	const star = STAR_DEFS[index];
	if (!star) throw new Error(`starPositionAt: unknown star index ${index}`);

	const { radius, inertia, chaseGapDeg, loops } = params;
	// Lead sits at the top (0°); trailers lag behind by `order · gap` degrees.
	const baseAngle = -star.order * chaseGapDeg;

	if (t < PHASE.restEnd) {
		return { x: star.cx, y: star.cy };
	}
	if (t < PHASE.riseEnd) {
		const u = (t - PHASE.restEnd) / (PHASE.riseEnd - PHASE.restEnd);
		const e = easeInOut(u, 3);
		const o = orbitPos(baseAngle, radius);
		return { x: lerp(star.cx, o.x, e), y: lerp(star.cy, o.y, e) };
	}
	if (t < PHASE.orbitEnd) {
		const u = (t - PHASE.riseEnd) / (PHASE.orbitEnd - PHASE.riseEnd);
		const angle = baseAngle + inertiaTurns(u, inertia, loops) * 360;
		return orbitPos(angle, radius);
	}
	// return → rest: orbit endpoint sits at the same screen spot as the rise
	// endpoint (baseAngle + loops·360 ≡ baseAngle), so we lerp straight home.
	const u = (t - PHASE.orbitEnd) / (1 - PHASE.orbitEnd);
	const e = easeInOut(u, 4);
	const endAngle = baseAngle + loops * 360;
	const o = orbitPos(endAngle, radius);
	return { x: lerp(o.x, star.cx, e), y: lerp(o.y, star.cy, e) };
}
