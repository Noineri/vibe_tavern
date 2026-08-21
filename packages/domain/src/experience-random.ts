/**
 * The Interactive-experience seeded RNG surface
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN Wave 1 / IR-12; relocated to the
 * zero-dep domain package by REALTIME_EXPERIENCE_MODE_PLAN RM-3).
 *
 * The server kernel and the browser-side frame kernel port MUST draw from the
 * SAME bit-identical stream: a realtime round executes ticks frame-side and the
 * round-commit replay (RM-8) re-runs them through the server kernel from the
 * session seed, comparing state hashes. Two copies of a PRNG are a drift bomb
 * (one algorithm tweak on one side → every commit 422s), so the stream lives
 * here once and both realms import it. `services/api` re-exports from the
 * kernel for import-path compatibility.
 */

import { shuffle } from "./experience-helpers.js";

/**
 * The seeded, host-owned RNG surface exposed as `context.random` when the
 * `deterministic_random` capability is granted. Every method draws from one
 * advancing cursor so a replayed seed + action sequence reproduces identical
 * values. Created once per session via {@link createDeterministicRandom}.
 */
export interface DeterministicRandom {
	float(): number;
	int(min: number, max: number): number;
	die(sides: number): number;
	pick<T>(items: readonly T[]): T;
	shuffle<T>(items: readonly T[]): T[];
	weightedPick<T extends { weight: number }>(items: readonly T[]): T;
}

/**
 * mulberry32 — a tiny deterministic PRNG (same algorithm as the prompt-script
 * VM's seeded helper). Exported so the lifecycle service can build a cursor-
 * counting wrapper on top of the SAME primitive (single source of truth for the
 * stream algorithm): the service pre-advances to a persisted cursor on resume
 * and counts subsequent draws so it can store the new cursor after each reduce.
 */
export function createMulberry32(seed: number): { next(): number } {
	let state = seed >>> 0;
	return {
		next(): number {
			state |= 0;
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		},
	};
}

/**
 * Build the {@link DeterministicRandom} surface over a uniform `[0, 1)` stream.
 * Shared by {@link createDeterministicRandom} (mulberry32, seeded) and
 * {@link createEphemeralRandom} (`Math.random`, non-recorded) so the surface
 * shape has one source of truth; the lifecycle service's cursor-counting wrapper
 * reuses the same shape too.
 */
function buildRandomSurface(next: () => number): DeterministicRandom {
	return {
		float: () => next(),
		int: (min: number, max: number): number => {
			if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
				throw new RangeError("random.int: min and max must be integers with min <= max");
			}
			return Math.floor(next() * (max - min + 1)) + min;
		},
		die: (sides: number): number => {
			if (!Number.isInteger(sides) || sides < 1) {
				throw new RangeError("random.die: sides must be a positive integer");
			}
			return Math.floor(next() * sides) + 1;
		},
		pick<T>(items: readonly T[]): T {
			if (!Array.isArray(items) || items.length === 0) {
				throw new RangeError("random.pick: a non-empty array is required");
			}
			return items[Math.floor(next() * items.length)];
		},
		shuffle<T>(items: readonly T[]): T[] {
			return shuffle(items, next);
		},
		weightedPick<T extends { weight: number }>(items: readonly T[]): T {
			if (!Array.isArray(items) || items.length === 0) {
				throw new RangeError("random.weightedPick: a non-empty array is required");
			}
			const total = items.reduce((sum, it) => sum + (Number(it.weight) || 0), 0);
			let roll = next() * total;
			for (const it of items) {
				roll -= Number(it.weight) || 0;
				if (roll <= 0) return it;
			}
			return items[items.length - 1];
		},
	};
}

/**
 * A stateful {@link DeterministicRandom} seeded once per session. The cursor
 * (count of draws consumed) is persisted alongside the seed (IR-21); resume
 * fast-forwards the stream to that cursor, and recalculation replay reproduces
 * it from the seed. Both paths use {@link createMulberry32}.
 */
export function createDeterministicRandom(seed: number): DeterministicRandom {
	return buildRandomSurface(createMulberry32(seed).next);
}

/**
 * The same shape as {@link DeterministicRandom}, but backed by `Math.random` —
 * non-recorded, non-reproducible. Injected as `context.chance` into `choose`
 * and `flavor` so a script can make a varied move or cosmetic detail without
 * disturbing the deterministic cursor (Variant Б).
 */
export type EphemeralRandom = DeterministicRandom;

/** Create an ephemeral `chance` surface (Math.random-backed, not recorded). */
export function createEphemeralRandom(): EphemeralRandom {
	return buildRandomSurface(Math.random);
}
