/**
 * Optional pure helpers for Interactive Runtime experiences
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1 / IR-12).
 *
 * These are generic, deterministic, side-effect-free recipes an authored
 * experience MAY use but never MUST use — "a hand-authored experience can ignore
 * all of them" (acceptance checklist). They intentionally assume no specific
 * game rules: turn order, series scoring, grids, decks, shuffle/deal, and
 * bounded selections are the only concerns. Win detection, scoring systems,
 * card ranks, and strategy are all package-authored on top of these primitives.
 *
 * Every randomized helper takes an explicit `rng: () => number` source (a
 * uniform [0, 1) stream) rather than reaching for `Math.random`, so a
 * deterministic {@link ExperienceHostContext.random} stream (IR-12 kernel) makes
 * replay reproduce identical values. None of these helpers mutate their inputs.
 *
 * The kernel injects a frozen {@link experienceHelpers} namespace into the
 * method-call context as `context.helpers`; the same functions are exported
 * individually for host-side use and direct unit testing.
 */

// ─── Round: turn order + series scoring ──────────────────────────────────────

/**
 * Rotate `order` so the element at `fromIndex` becomes first, preserving the
 * cyclic sequence. Negative and overflowing indices wrap. An empty order yields
 * an empty result. Pure — returns a new array.
 */
export function rotateOrder(
	order: readonly string[],
	fromIndex: number,
): string[] {
	if (order.length === 0) return [];
	const i = ((Math.trunc(fromIndex) % order.length) + order.length) % order.length;
	return order.slice(i).concat(order.slice(0, i));
}

/**
 * Advance a turn cursor: `(currentIndex + 1) % count`. Throws if `count` is not
 * a positive integer (a turn order with zero seats is a package bug).
 */
export function nextTurnIndex(count: number, currentIndex: number): number {
	if (!Number.isInteger(count) || count <= 0) {
		throw new RangeError("nextTurnIndex: count must be a positive integer");
	}
	const i = Math.trunc(currentIndex);
	return ((i % count) + count) % count;
}

/**
 * Sum per-participant scores across rounds into `{ [participantId]: total }`.
 * Pure — builds a fresh record. Entries with equal ids accumulate.
 */
export function sumScores(
	entries: ReadonlyArray<{ participantId: string; score: number }>,
): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const entry of entries) {
		totals[entry.participantId] = (totals[entry.participantId] ?? 0) + entry.score;
	}
	return totals;
}

// ─── Board: grids ────────────────────────────────────────────────────────────

/**
 * Build a `height × width` grid `[y][x]` where each cell is `fill(x, y)`.
 * Throws on non-positive dimensions. Pure — returns a new array of arrays.
 */
export function createGrid<T>(
	width: number,
	height: number,
	fill: (x: number, y: number) => T,
): T[][] {
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new RangeError("createGrid: width and height must be positive integers");
	}
	const grid: T[][] = [];
	for (let y = 0; y < height; y += 1) {
		const row: T[] = [];
		for (let x = 0; x < width; x += 1) row.push(fill(x, y));
		grid.push(row);
	}
	return grid;
}

/** The 4-connected orthogonal neighbors of `(x, y)` within a `width × height` bounds. */
export function gridNeighbors4(
	x: number,
	y: number,
	width: number,
	height: number,
): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	if (x > 0) out.push({ x: x - 1, y });
	if (x < width - 1) out.push({ x: x + 1, y });
	if (y > 0) out.push({ x, y: y - 1 });
	if (y < height - 1) out.push({ x, y: y + 1 });
	return out;
}

/** Return a shallow copy of grid row `y` (empty if absent). */
export function getRow<T>(grid: readonly (readonly T[])[], y: number): T[] {
	const row = grid[y];
	return row === undefined ? [] : row.slice();
}

/** Return the cells of column `x` across all rows. */
export function getColumn<T>(grid: readonly (readonly T[])[], x: number): T[] {
	const out: T[] = [];
	for (const row of grid) {
		if (row !== undefined && x < row.length) out.push(row[x]);
	}
	return out;
}

// ─── Card: decks ─────────────────────────────────────────────────────────────

/** A minimal card shape: a `suit`/`rank` pair. The package owns rank ordering. */
export interface PlayingCard {
	suit: string;
	rank: string;
}

/**
 * Build the cartesian product of `suits × ranks` as cards, in deterministic
 * suit-major order. Pure — the package may `shuffle()` the result with its
 * granted deterministic-random stream.
 */
export function createDeck(
	suits: readonly string[],
	ranks: readonly string[],
): PlayingCard[] {
	const deck: PlayingCard[] = [];
	for (const suit of suits) {
		for (const rank of ranks) {
			deck.push({ suit, rank });
		}
	}
	return deck;
}

/**
 * Fisher–Yates shuffle returning a NEW array; `items` is never mutated. Pure and
 * deterministic given `rng`. An empty or single-element array returns a copy.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

/** The result of {@link deal}: one hand per seat plus the undealt remainder. */
export interface DealResult<T> {
	hands: T[][];
	remaining: T[];
}

/**
 * Deal `perHand` cards to each of `handCount` hands, round-robin from the front
 * of `deck`. Stops cleanly if the deck runs out. Pure — `deck` is not mutated.
 */
export function deal<T>(
	deck: readonly T[],
	handCount: number,
	perHand: number,
): DealResult<T> {
	if (!Number.isInteger(handCount) || handCount <= 0) {
		throw new RangeError("deal: handCount must be a positive integer");
	}
	if (!Number.isInteger(perHand) || perHand < 0) {
		throw new RangeError("deal: perHand must be a non-negative integer");
	}
	const hands: T[][] = Array.from({ length: handCount }, () => []);
	const work = deck.slice();
	for (let round = 0; round < perHand; round += 1) {
		for (let h = 0; h < handCount; h += 1) {
			if (work.length === 0) return { hands, remaining: work };
			hands[h].push(work.shift() as T);
		}
	}
	return { hands, remaining: work };
}

// ─── Bounded selections + small numerics ─────────────────────────────────────

/**
 * Pick `count` distinct items from `items` using `rng`. Throws if `count` is
 * negative or exceeds `items.length`. Deterministic given `rng`; pure.
 */
export function pickDistinct<T>(
	items: readonly T[],
	count: number,
	rng: () => number,
): T[] {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError("pickDistinct: count must be a non-negative integer");
	}
	if (count > items.length) {
		throw new RangeError("pickDistinct: count exceeds items length");
	}
	return shuffle(items, rng).slice(0, count);
}

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
	if (min > max) return Math.min(min, Math.max(max, value));
	return Math.min(max, Math.max(min, value));
}

/**
 * Produce `[0, 1, …, count-1]`. Throws if `count` is negative. Pure — used to
 * enumerate seats/cells without a hand-written loop boilerplate.
 */
export function range(count: number): number[] {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError("range: count must be a non-negative integer");
	}
	const out: number[] = [];
	for (let i = 0; i < count; i += 1) out.push(i);
	return out;
}

// ─── Bounded history ─────────────────────────────────────────────────────────

/**
 * Keep only the most recent `max` items (the tail) of `items`, returning a NEW
 * array. Pure — never mutates `items`; deterministic (no `rng`). `max = 0`
 * yields an empty array; `max >= items.length` yields a full shallow copy.
 * Throws if `max` is not a non-negative integer (a negative/NaN bound is a
 * package bug, not a runtime value). Long-form authors use this to bound
 * history-bearing state (messenger messages, campaign journals) against the
 * kernel's bounded-JSON state limits.
 */
export function keepLast<T>(items: readonly T[], max: number): T[] {
	if (!Number.isInteger(max) || max < 0) {
		throw new RangeError("keepLast: max must be a non-negative integer");
	}
	return items.slice(Math.max(0, items.length - max));
}

// ─── Frozen namespace for VM injection ───────────────────────────────────────

/**
 * The frozen `context.helpers` namespace the kernel injects into every
 * method-call context. Frozen so a script cannot replace or poison a helper;
 * inert if the script never reads it.
 */
export const experienceHelpers = Object.freeze({
	rotateOrder,
	nextTurnIndex,
	sumScores,
	createGrid,
	gridNeighbors4,
	getRow,
	getColumn,
	createDeck,
	shuffle,
	deal,
	pickDistinct,
	clamp,
	range,
	keepLast,
});

export type ExperienceHelpers = typeof experienceHelpers;
