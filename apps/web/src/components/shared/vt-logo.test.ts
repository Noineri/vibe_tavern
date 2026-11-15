import { describe, expect, it } from "bun:test";
import {
	BOOK_CENTER,
	BOOK_PATH,
	inertiaTurns,
	MOTION_DEFAULTS,
	PHASE,
	STAR_DEFS,
	starPositionAt,
} from "./vt-logo.js";

const { radius, inertia, loops } = MOTION_DEFAULTS;
const EPS = 1e-6;

describe("vt-logo — static definition", () => {
	it("exposes the book path and exactly three stars (large→medium→tiny)", () => {
		expect(BOOK_PATH.startsWith("M228.277")).toBe(true);
		expect(STAR_DEFS).toHaveLength(3);
		expect(STAR_DEFS.map((s) => s.order)).toEqual([0, 1, 2]);
	});

	it("each star path is present and non-empty", () => {
		for (const s of STAR_DEFS) {
			expect(s.path.startsWith("M")).toBe(true);
			expect(s.path.length).toBeGreaterThan(50);
		}
	});
});

describe("vt-logo — rest phase holds the natural logo pose", () => {
	it("returns each star's exact resting center for t ∈ [0, restEnd)", () => {
		for (let i = 0; i < STAR_DEFS.length; i++) {
			const star = STAR_DEFS[i];
			for (const t of [0, 0.02, 0.04, PHASE.restEnd - EPS]) {
				const p = starPositionAt(t, i);
				expect(p.x).toBeCloseTo(star.cx, 5);
				expect(p.y).toBeCloseTo(star.cy, 5);
			}
		}
	});
});

describe("vt-logo — the loop is seamless", () => {
	it("position at t=0 equals position at t=1 for every star", () => {
		for (let i = 0; i < STAR_DEFS.length; i++) {
			const a = starPositionAt(0, i);
			const b = starPositionAt(1, i);
			expect(a.x).toBeCloseTo(b.x, 5);
			expect(a.y).toBeCloseTo(b.y, 5);
		}
	});

	it("has no positional jump at the rise→orbit boundary", () => {
		for (let i = 0; i < STAR_DEFS.length; i++) {
			const a = starPositionAt(PHASE.riseEnd - EPS, i);
			const b = starPositionAt(PHASE.riseEnd + EPS, i);
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
		}
	});

	it("has no positional jump at the orbit→return boundary", () => {
		for (let i = 0; i < STAR_DEFS.length; i++) {
			const a = starPositionAt(PHASE.orbitEnd - EPS, i);
			const b = starPositionAt(PHASE.orbitEnd + EPS, i);
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
		}
	});
});

describe("vt-logo — orbit geometry", () => {
	it("stars ride exactly on the orbit circle during the orbit phase", () => {
		for (let i = 0; i < STAR_DEFS.length; i++) {
			for (const u of [0.05, 0.25, 0.5, 0.75, 0.95]) {
				const t = PHASE.riseEnd + u * (PHASE.orbitEnd - PHASE.riseEnd);
				const p = starPositionAt(t, i);
				const d = Math.hypot(p.x - BOOK_CENTER.x, p.y - BOOK_CENTER.y);
				expect(d).toBeCloseTo(radius, 3);
			}
		}
	});

	it("the orbit radius clears the book (circle is larger than the book half-extent)", () => {
		// Book spans roughly x ∈ [0, 285] around center ≈ 142.5, so its horizontal
		// half-extent is ~143. The orbit must exceed that so stars never clip pages.
		expect(radius).toBeGreaterThan(143);
	});
});

describe("vt-logo — inertial bottom whip", () => {
	it("inertiaTurns derivative is maximal at the bottom and minimal at the apex", () => {
		// Finite-difference the real inertiaTurns(u, inertia, loops) at apex (u=0) vs bottom (u=0.5/loops).
		const du = 1e-4;
		const rateAt = (u: number) =>
			(inertiaTurns(u + du, inertia, loops) - inertiaTurns(u - du, inertia, loops)) / (2 * du);
		const speedTop = rateAt(0);
		const speedMid = rateAt(0.25 / loops);
		const speedBottom = rateAt(0.5 / loops);
		expect(speedTop).toBeLessThan(speedMid);
		expect(speedBottom).toBeGreaterThan(speedMid);
		expect(speedBottom / speedTop).toBeGreaterThan(8); // ~10× with A=0.82
	});

	it("stars move much faster through the bottom than over the apex", () => {
		// Finite-difference the actual star path over a tiny dt at apex vs bottom.
		const span = PHASE.orbitEnd - PHASE.riseEnd;
		const tTop = PHASE.riseEnd + 0.01 * span;
		const tBottom = PHASE.riseEnd + 0.5 * span;
		const dt = 0.0005;
		const i = 0;
		const move = (t: number) => {
			const a = starPositionAt(t, i);
			const b = starPositionAt(t + dt, i);
			return Math.hypot(a.x - b.x, a.y - b.y);
		};
		expect(move(tBottom)).toBeGreaterThan(move(tTop) * 3);
	});
});
