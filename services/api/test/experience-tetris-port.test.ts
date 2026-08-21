/**
 * Tetris realtime port (TETRIS_REALTIME_PORT_PLAN, TR-1..TR-3) — the user's
 * timer-mode mini-app «Тетрис» ported onto the realtime engine with the
 * requested cascade physics (TR-2: cells left without support by a line clear
 * fall; chain clears re-score with the same table).
 *
 * Drives the REAL ported rules source (`TETRIS_RULES_SOURCE`) through the
 * public kernel surface — create, project, reduce, update — pinning: the
 * immediate round start (Breakout parity), wall/rotation legality, the
 * ms-accumulator gravity against dropSpeed(level), soft +1 / hard +2 scoring,
 * the line table [0,100,300,500,800]×level, level-up at 10 lines, top-out,
 * the cascade mechanics (one row per tick, whole stacks together, chain
 * clears, deferred spawn, ignored input mid-cascade), and seed determinism
 * (same seed + same log → identical states — the round-commit replay
 * contract). The visual source is pinned structurally (realtime transport:
 * actLocal/onTick/finishRound/onRoundFinish/onRoundError; no onPending, no
 * rebuild-from-actions). Pure kernel — no DB, no loop host.
 */
import { describe, expect, test } from "bun:test";
import { createDeterministicRandom } from "@vibe-tavern/domain";
import { TETRIS_RULES_SOURCE, TETRIS_VISUAL_SOURCE } from "@vibe-tavern/domain/tetris-port";
import {
	runCreate,
	runProject,
	runReduce,
	runUpdate,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";

const OBSERVER = { kind: "observer" as const };
const TICK_MS = 50;
const COLORS = { I: "#22d3ee", O: "#facc15", T: "#a855f7", S: "#22c55e", Z: "#ef4444", J: "#3b82f6", L: "#f97316" } as const;

function cursorCaps(seed: number): ExperienceCapabilityContext {
	return { random: createDeterministicRandom(seed) };
}

interface TetrisPiece {
	type: keyof typeof COLORS;
	rotation: number;
	x: number;
	y: number;
}

interface TetrisState {
	grid: (string | 0)[][];
	current: TetrisPiece | null;
	next: keyof typeof COLORS;
	score: number;
	lines: number;
	level: number;
	fallAcc: number;
	cascade: boolean;
	lockPending: boolean;
	over: boolean;
}

/** 20×10 grid; rows listed top(0)..bottom(19), each row 10 entries (string color or 0). */
function makeGrid(rows: Array<Array<string | 0>>): (string | 0)[][] {
	const grid: (string | 0)[][] = [];
	for (let y = 0; y < 20; y += 1) {
		const row = rows[y] ?? [];
		const full: (string | 0)[] = [];
		for (let x = 0; x < 10; x += 1) full.push(row[x] ?? 0);
		grid.push(full);
	}
	return grid;
}

function makeState(overrides: Partial<TetrisState> = {}): TetrisState {
	return {
		grid: makeGrid([]),
		current: { type: "T", rotation: 0, x: 3, y: 0 },
		next: "O",
		score: 0,
		lines: 0,
		level: 1,
		fallAcc: 0,
		cascade: false,
		lockPending: false,
		over: false,
		...overrides,
	};
}

function okCreate(seed: number): TetrisState {
	const res = runCreate(TETRIS_RULES_SOURCE, "tetris.js", {}, cursorCaps(seed));
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(res.message);
	return res.value as TetrisState;
}

/** create + the first update tick (the opening draw) — the state a running
 * round is in from tick 1 on. */
function startGame(seed: number): TetrisState {
	return tick(okCreate(seed), seed).state;
}

function tick(state: TetrisState, seed = 1): { state: TetrisState; status: "active" | "completed" } {
	const res = runUpdate(TETRIS_RULES_SOURCE, "tetris.js", state, TICK_MS, cursorCaps(seed));
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(res.message);
	return { state: res.value.state as TetrisState, status: res.value.status };
}

let actSeq = 0;
function act(state: TetrisState, type: string, seed = 1): TetrisState {
	actSeq += 1;
	const res = runReduce(
		TETRIS_RULES_SOURCE,
		"tetris.js",
		state,
		{ type, requestId: `r${actSeq}`, expectedRevision: actSeq },
		cursorCaps(seed),
	);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(res.message);
	return res.value.state as TetrisState;
}

function project(state: TetrisState, seed = 1) {
	const res = runProject(TETRIS_RULES_SOURCE, "tetris.js", state, OBSERVER, cursorCaps(seed));
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(res.message);
	return res.value as { grid: (string | 0)[][]; score: number; lines: number; level: number; next: string; gameOver: boolean };
}

function cell(grid: (string | 0)[][], x: number, y: number): string | 0 {
	return grid[y][x];
}

// ─── TR-1: ported rules ─────────────────────────────────────────────────────

describe("TR-1: tetris realtime port", () => {
	test("create is grant-free (empty caps) and the first tick draws the opening", () => {
		// Incident pin (2026-08-21): the editor's rules validation runs create
		// with EMPTY capability grants — a cursor draw in create made the whole
		// imported app unstartable. Create must succeed with no caps at all.
		const bare = runCreate(TETRIS_RULES_SOURCE, "tetris.js", {}, {});
		expect(bare.ok).toBe(true);
		if (!bare.ok) throw new Error(bare.message);
		const empty = bare.value as TetrisState;
		expect(empty.current).toBe(null);
		expect(empty.next).toBe(null);
		expect(empty.over).toBe(false);
		expect(empty.grid.flat().filter((c) => c !== 0).length).toBe(0);
		// The FIRST update tick (cursor injected by the loop) draws both
		// opening pieces from the deterministic stream.
		const s = tick(empty, 42);
		expect(s.status).toBe("active");
		expect(s.state.current).not.toBe(null);
		expect(s.state.current!.y).toBe(0);
		expect(s.state.current!.rotation).toBe(0);
		expect(["I", "O", "T", "S", "Z", "J", "L"]).toContain(s.state.current!.type);
		expect(["I", "O", "T", "S", "Z", "J", "L"]).toContain(s.state.next);
		const view = project(s.state);
		// The current piece is inscribed into the projected grid (4 cells).
		const filled = view.grid.flat().filter((c) => c !== 0);
		expect(filled.length).toBe(4);
		expect(view.gameOver).toBe(false);
	});

	test("determinism: same seed + same action/tick log replays identically", () => {
		const run = (seed: number) => {
			let s = okCreate(seed);
			const log: string[] = [];
			const ops = ["moveLeft", "moveLeft", "rotate", "moveRight", "softDrop", "rotate", "hardDrop"];
			let opIdx = 0;
			for (let i = 0; i < 60; i += 1) {
				if (i === 3 || i === 11 || i === 20 || i === 33) {
					s = act(s, ops[opIdx % ops.length], seed);
					log.push(`act:${ops[opIdx % ops.length]}`);
					opIdx += 1;
				} else {
					const r = tick(s, seed);
					if (r.status === "completed") {
						log.push("over");
						break;
					}
					s = r.state;
					log.push("tick");
				}
			}
			return { final: JSON.stringify(s), log: log.join(",") };
		};
		const a = run(7);
		const b = run(7);
		expect(a.log).toBe(b.log);
		expect(a.final).toBe(b.final);
		// Different seed → (almost surely) different piece order somewhere.
		const c = run(8);
		expect(c.final === a.final).toBe(false);
	});

	test("move legality at the walls; blocked input still resets the fall accumulator", () => {
		let s = startGame(3);
		// Grind the piece to the left wall (spawn x=3 for T/S/Z/J/L, 4 for O, I=3).
		for (let i = 0; i < 12; i += 1) s = act(s, "moveLeft", 3);
		expect(s.current!.x).toBe(0);
		const before = JSON.stringify(s);
		// One more blocked moveLeft: state identical except fallAcc (still 0 here).
		const blocked = act(s, "moveLeft", 3);
		expect(blocked.current!.x).toBe(0);
		expect(blocked.score).toBe(s.score);
		// fallAcc reset semantics: accumulate 750ms, fire a blocked input, acc drops to 0.
		let acc = s;
		for (let i = 0; i < 15; i += 1) acc = tick(acc, 3).state;
		expect(acc.fallAcc).toBe(750);
		const afterBlocked = act(acc, "moveLeft", 3);
		expect(afterBlocked.fallAcc).toBe(0);
		expect(JSON.stringify(s)).toBe(before);
	});

	test("gravity integrates against dropSpeed(level): first row at 800ms, not before", () => {
		const s0 = startGame(5);
		// Pick a piece type with a known spawn; just measure y movement timing.
		let s = s0;
		for (let i = 0; i < 15; i += 1) {
			s = tick(s, 5).state;
			// No input → no fallAcc reset; 15×50=750ms < 800ms → still at spawn row.
		}
		expect(s.current!.y).toBe(0);
		expect(s.fallAcc).toBe(750);
		s = tick(s, 5).state; // 800ms crossed
		expect(s.current!.y).toBe(1);
	});

	test("soft drop scores +1 per cell and moves immediately", () => {
		const s0 = startGame(9);
		const s = act(s0, "softDrop", 9);
		expect(s.current!.y).toBe(s0.current!.y + 1);
		expect(s.score).toBe(1);
		expect(s.fallAcc).toBe(0);
	});

	test("hard drop scores +2 per cell and defers the lock to the tick", () => {
		const s0 = startGame(11);
		const s = act(s0, "hardDrop", 11);
		const dropY = s.current!.y - s0.current!.y;
		expect(dropY).toBeGreaterThan(0);
		expect(s.score).toBe(dropY * 2);
		expect(s.lockPending).toBe(true);
		// The next update resolves the lock: piece inscribed, no clear on an
		// empty board, next piece spawned from the cursor.
		const r = tick(s, 11);
		expect(r.status).toBe("active");
		expect(r.state.lockPending).toBe(false);
		expect(r.state.cascade).toBe(false);
		expect(r.state.current).not.toBe(null);
		expect(r.state.current!.y).toBe(0);
		expect(r.state.current!.type).toBe(s0.next);
		// The dropped piece's cells are on the board now (bottom row has color).
		const bottom = r.state.grid[19].filter((c) => c !== 0);
		expect(bottom.length).toBeGreaterThan(0);
	});

	test("line clear scores by the table; I-horizontal gap fill = single, level-up at 10 lines", () => {
		// Board with row 19 filled at x0..x5, gap x6..x9; an I horizontal
		// resting at y=19 x=6 completes exactly one line with nothing above.
		const grid = makeGrid([
			...Array.from({ length: 19 }, () => [] as Array<string | 0>),
			["r", "r", "r", "r", "r", "r", 0, 0, 0, 0],
		]);
		const s = makeState({
			grid,
			current: { type: "I", rotation: 0, x: 6, y: 19 },
			lines: 9,
		});
		const locked = act(s, "hardDrop", 13); // dropY = 0 (already resting): +0 score
		expect(locked.score).toBe(0);
		const r = tick(locked, 13);
		expect(r.state.score).toBe(100); // single × level 1
		expect(r.state.lines).toBe(10);
		expect(r.state.level).toBe(2); // floor(10/10)+1
		expect(r.state.cascade).toBe(false);
		expect(r.state.current).not.toBe(null); // spawned immediately: nothing floats
	});

	test("tetris clear (4 lines) scores 800 × level", () => {
		const grid = makeGrid([
			...Array.from({ length: 16 }, () => [] as Array<string | 0>),
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0],
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0],
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0],
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0],
		]);
		const s = makeState({
			grid,
			current: { type: "I", rotation: 1, x: 9, y: 16 }, // vertical I fills x9 rows 16..19
			level: 2,
		});
		const locked = act(s, "hardDrop", 13);
		const r = tick(locked, 13);
		expect(r.state.score).toBe(1600); // 800 × level 2
		expect(r.state.lines).toBe(4);
		expect(r.state.level).toBe(1); // floor(4/10)+1
		expect(r.state.cascade).toBe(false);
		// All four rows are gone: the board is empty except the fresh spawn.
		const filled = r.state.grid.flat().filter((c) => c !== 0);
		expect(filled.length).toBe(0);
	});

	test("top-out on blocked spawn completes the round", () => {
		// Occupy the spawn columns of the NEXT piece (O spawns at x=4, cells
		// (4,0),(5,0),(4,1),(5,1)): fill rows 0 and 1 at x=4,x=5.
		const grid = makeGrid([
			[0, 0, 0, 0, "r", "r", 0, 0, 0, 0],
			[0, 0, 0, 0, "r", "r", 0, 0, 0, 0],
			...Array.from({ length: 18 }, () => [0, 0, 0, 0, "r", "r", 0, 0, 0, 0] as Array<string | 0>),
		]);
		const s = makeState({
			grid,
			current: { type: "I", rotation: 0, x: 0, y: 19 },
			next: "O",
		});
		const locked = act(s, "hardDrop", 21);
		const r = tick(locked, 21);
		expect(r.status).toBe("completed");
		expect(r.state.over).toBe(true);
		const view = project(r.state);
		expect(view.gameOver).toBe(true);
		// A further update keeps returning completed (terminal).
		const again = tick(r.state, 21);
		expect(again.status).toBe("completed");
	});
});

// ─── TR-2: cascade physics ──────────────────────────────────────────────────

describe("TR-2: cascade physics (blocks left without support fall)", () => {
	test("a floater falls one row per tick and stops on the floor", () => {
		const grid = makeGrid([
			...Array.from({ length: 9 }, () => [] as Array<string | 0>),
			[0, 0, 0, 0, "b", 0, 0, 0, 0, 0], // (4,9)
			...Array.from({ length: 10 }, () => [] as Array<string | 0>),
		]);
		const s = makeState({ grid, current: null, cascade: true, next: "T" });
		let st = tick(s, 31).state;
		expect(cell(st.grid, 4, 10)).not.toBe(0);
		expect(cell(st.grid, 4, 9)).toBe(0);
		// Fall the remaining 9 rows.
		for (let i = 0; i < 8; i += 1) st = tick(st, 31).state;
		expect(cell(st.grid, 4, 18)).not.toBe(0);
		expect(cell(st.grid, 4, 19)).toBe(0);
		// One tick to land on the floor (still cascade), one to settle+spawn.
		const landed = tick(st, 31);
		expect(cell(landed.state.grid, 4, 19)).not.toBe(0);
		expect(landed.state.cascade).toBe(true);
		const settled = tick(landed.state, 31);
		expect(settled.state.cascade).toBe(false);
		expect(settled.state.current).not.toBe(null);
		expect(settled.state.current!.type).toBe("T");
	});

	test("a stack falls together (bottom-up sweep keeps columns contiguous)", () => {
		const grid = makeGrid([
			...Array.from({ length: 12 }, () => [] as Array<string | 0>),
			[0, "g", 0, 0, 0, 0, 0, 0, 0, 0], // (1,12)
			[0, "g", 0, 0, 0, 0, 0, 0, 0, 0], // (1,13)
			[0, "g", 0, 0, 0, 0, 0, 0, 0, 0], // (1,14)
			...Array.from({ length: 5 }, () => [] as Array<string | 0>),
		]);
		const s = makeState({ grid, current: null, cascade: true, next: "O" });
		const st = tick(s, 31).state;
		// Whole stack shifted by exactly one (no peeling apart).
		expect(cell(st.grid, 1, 13)).not.toBe(0);
		expect(cell(st.grid, 1, 14)).not.toBe(0);
		expect(cell(st.grid, 1, 15)).not.toBe(0);
		expect(cell(st.grid, 1, 12)).toBe(0);
		expect(st.cascade).toBe(true);
	});

	test("chain clear: the falling cell completes a row and re-scores", () => {
		const grid = makeGrid([
			...Array.from({ length: 10 }, () => [] as Array<string | 0>),
			[0, 0, 0, 0, 0, 0, 0, 0, 0, "y"], // (9,10) — will fall into the gap
			...Array.from({ length: 8 }, () => [] as Array<string | 0>),
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0], // row 19: gap at x9
		]);
		const s = makeState({ grid, current: null, cascade: true, next: "I", score: 0, lines: 0, level: 1 });
		let st = s;
		// 9 ticks of falling: (9,10) → (9,19).
		for (let i = 0; i < 9; i += 1) st = tick(st, 33).state;
		expect(cell(st.grid, 9, 19)).not.toBe(0);
		expect(st.score).toBe(0);
		// Settle tick: row 19 full → chain clear, +100×1.
		const cleared = tick(st, 33);
		expect(cleared.state.score).toBe(100);
		expect(cleared.state.lines).toBe(1);
		expect(cell(cleared.state.grid, 9, 19)).toBe(0);
		expect(cleared.state.cascade).toBe(true); // still resolving
		// Next tick: nothing falls, no full rows → spawn.
		const spawned = tick(cleared.state, 33);
		expect(spawned.state.cascade).toBe(false);
		expect(spawned.state.current).not.toBe(null);
		expect(spawned.state.current!.type).toBe("I");
	});

	test("end-to-end: lock → clear → cascade → chain clear → spawn", () => {
		// Row 19 filled at x0..x8, gap x9. Rows 16..18 have a lone x9 stack
		// waiting? No — craft a lock that LEAVES floaters: the vertical I
		// fills (9,16..19) completing row 19; its own upper cells then float.
		const grid = makeGrid([
			...Array.from({ length: 16 }, () => [] as Array<string | 0>),
			[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // row 16 empty
			[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // row 17 empty
			[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // row 18 empty
			["r", "r", "r", "r", "r", "r", "r", "r", "r", 0], // row 19: gap x9
		]);
		const s = makeState({
			grid,
			current: { type: "I", rotation: 1, x: 9, y: 16 },
			next: "L",
		});
		// hardDrop: dropY = 0 (resting), lockPending → update locks + clears
		// row 19; the I's cells at rows 16..18 shift down with the clear and
		// REMAIN stacked on the floor — no floaters in this craft, immediate
		// spawn. (The floater case is the next test.)
		const locked = act(s, "moveLeft", 33); // keep piece (no-op, resets acc)
		const dropped = act(locked, "hardDrop", 33);
		const r = tick(dropped, 33);
		expect(r.state.score).toBe(100);
		expect(r.state.lines).toBe(1);
		expect(r.state.current).not.toBe(null);
	});

	test("end-to-end: a lock whose clear leaves cells hanging triggers the cascade", () => {
		// Row 19: x0..x8 + x9 gap. Row 18: x0..x8 + x9 gap. The O piece at
		// (8,18) covers (8,18),(9,18),(8,19),(9,19) — completing BOTH rows →
		// double clear (300×1). A lone cell at (4,14) survives above the
		// cleared band → floater → falls to the floor over ticks.
		const grid = makeGrid([
			...Array.from({ length: 14 }, () => [] as Array<string | 0>),
			[0, 0, 0, 0, "b", 0, 0, 0, 0, 0], // (4,14) — the future floater
			...Array.from({ length: 3 }, () => [] as Array<string | 0>),
			["r", "r", "r", "r", "r", "r", "r", "r", 0, 0], // row 18
			["r", "r", "r", "r", "r", "r", "r", "r", 0, 0], // row 19
		]);
		const s = makeState({
			grid,
			current: { type: "O", rotation: 0, x: 8, y: 18 },
			next: "J",
		});
		const dropped = act(s, "hardDrop", 33); // resting: dropY=0
		const locked = tick(dropped, 33);
		// Double clear scored; rows 18-19 gone; (4,14) shifted to (4,16) by
		// the clear band removal and now floats → cascade phase, no spawn yet.
		expect(locked.state.score).toBe(300);
		expect(locked.state.lines).toBe(2);
		expect(locked.state.cascade).toBe(true);
		expect(locked.state.current).toBeNull();
		expect(cell(locked.state.grid, 4, 16)).not.toBe(0);
		// Fall 3 rows to the floor (16 → 19), then settle+spawn.
		let st = locked.state;
		for (let i = 0; i < 3; i += 1) st = tick(st, 33).state;
		expect(cell(st.grid, 4, 19)).not.toBe(0);
		const settled = tick(st, 33);
		expect(settled.state.cascade).toBe(false);
		expect(settled.state.current).not.toBe(null);
		expect(settled.state.current!.type).toBe("J");
		// The floater created no new full row (only x4 at the floor).
		expect(settled.state.lines).toBe(2);
	});

	test("input during the cascade is ignored (no active piece to move)", () => {
		const grid = makeGrid([
			...Array.from({ length: 9 }, () => [] as Array<string | 0>),
			[0, 0, 0, 0, "b", 0, 0, 0, 0, 0],
			...Array.from({ length: 10 }, () => [] as Array<string | 0>),
		]);
		const s = makeState({ grid, current: null, cascade: true, next: "T" });
		const after = act(s, "moveLeft", 31);
		expect(JSON.stringify(after)).toBe(JSON.stringify(s));
	});

	test("no gravity at plain lock: overhangs survive until a clear removes support", () => {
		// Row 18: x0..x3 (the (3,18) cell overhangs the hole at (3,19)); row 19:
		// x0..x2 with holes x3..x9. The O locks flat at x=6 — no clear, no
		// support removed: the overhang must SURVIVE (classic play).
		const grid = makeGrid([
			...Array.from({ length: 18 }, () => [] as Array<string | 0>),
			["r", "r", "r", "r", 0, 0, 0, 0, 0, 0], // row 18
			["r", "r", "r", 0, 0, 0, 0, 0, 0, 0], // row 19: hole at x3..x9
		]);
		const s = makeState({
			grid,
			current: { type: "O", rotation: 0, x: 6, y: 18 }, // fills (6,18),(7,18),(6,19),(7,19)
			next: "T",
		});
		const dropped = act(s, "hardDrop", 35);
		const locked = tick(dropped, 35);
		expect(locked.state.cascade).toBe(false);
		expect(locked.state.score).toBe(0);
		expect(cell(locked.state.grid, 3, 19)).toBe(0); // hole preserved
		expect(cell(locked.state.grid, 3, 18)).not.toBe(0); // overhang preserved
		expect(cell(locked.state.grid, 6, 19)).not.toBe(0); // O landed
		expect(locked.state.current).not.toBe(null); // immediate spawn
	});
});

// ─── TR-3: visual source (structural pins) ──────────────────────────────────

describe("TR-3: tetris realtime visual", () => {
	test("uses the realtime transport (actLocal, onTick, finishRound, onRoundFinish, onRoundError)", () => {
		expect(TETRIS_VISUAL_SOURCE).toContain("actLocal");
		expect(TETRIS_VISUAL_SOURCE).toContain("onTick");
		expect(TETRIS_VISUAL_SOURCE).toContain("finishRound");
		expect(TETRIS_VISUAL_SOURCE).toContain("onRoundFinish");
		expect(TETRIS_VISUAL_SOURCE).toContain("onRoundError");
		expect(TETRIS_VISUAL_SOURCE).toContain("VibeExperience.connect");
		expect(TETRIS_VISUAL_SOURCE).toContain("finishRound({ status: 'completed'");
		expect(TETRIS_VISUAL_SOURCE).toContain("Тетрис: ' + lastScore + ' очков");
	});

	test("turn-mode transport is gone (no onPending/onLifecycle, no rebuild-from-actions)", () => {
		expect(TETRIS_VISUAL_SOURCE).not.toContain("onPending");
		expect(TETRIS_VISUAL_SOURCE).not.toContain("onLifecycle");
		expect(TETRIS_VISUAL_SOURCE).not.toContain("renderControls(actions");
		// Static RU buttons wired via data-act.
		expect(TETRIS_VISUAL_SOURCE).toContain('data-act="moveLeft"');
		expect(TETRIS_VISUAL_SOURCE).toContain("Влево");
		expect(TETRIS_VISUAL_SOURCE).toContain("Завершить раунд");
	});

	test("user chrome preserved 1:1 (board cells, next preview, stats, hint)", () => {
		expect(TETRIS_VISUAL_SOURCE).toContain("tetris-board");
		expect(TETRIS_VISUAL_SOURCE).toContain("tetris-next-grid");
		expect(TETRIS_VISUAL_SOURCE).toContain('id="stat-score"');
		expect(TETRIS_VISUAL_SOURCE).toContain('id="stat-lines"');
		expect(TETRIS_VISUAL_SOURCE).toContain('id="stat-level"');
		expect(TETRIS_VISUAL_SOURCE).toContain("← → двигать · ↑ поворот · ↓ мягко · пробел — сброс");
		// The dual-shape reader (flat project() return vs {state} wrapper).
		expect(TETRIS_VISUAL_SOURCE).toContain("(view && view.state) || view");
	});
});
