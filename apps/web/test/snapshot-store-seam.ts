/**
 * The ONE shared `stores/snapshot-store.js` seam for every apps/web test file
 * that narrows a snapshot-store hook (ScriptEditor's `useAllCharacters`,
 * ExperienceSetupModal's `useAllCharacters`/`useChatList`,
 * ExperienceLauncher's `useSnapshotStore`) AND every suite that needs the
 * REAL zustand store (rail-character-browser's rail rows, topbar-regex's
 * `useSnapshotStore.getState().ingestSnapshot(...)` seeding).
 *
 * CO-LOAD CONTRACT (same discipline as test/bootstrap-actions-seam.ts — the
 * sibling store seam): `mock.module` is process-global and last-write-wins,
 * and a hand-bundled run shares the module registry in an effectively
 * ARBITRARY file order (probe evidence 2026-10-27: ExperienceSetupModal's
 * registration poisoned ScriptEditor in BOTH argument orders) — so a file
 * that replaces a hook with a plain function leaves it live for every other
 * file in the process. Reproduced: ScriptEditor's `useAllCharacters` mock
 * (returning its own fixture array) made rail-character-browser fail 68/68
 * rows/counts pins; ExperienceSetupModal's `useChatList`/`useAllCharacters`
 * narrows do the same to any rider after them.
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP (see the bootstrap-actions seam
 * header): a rider cannot un-poison itself with the R4 spread — the captured
 * namespace's hook slot already holds the narrowing function. The seam
 * captures the real namespace and the real `useSnapshotStore` as a bare
 * reference ONCE, at the seam module's first import (every family member
 * imports the seam before registering, so the capture is clean).
 *
 * Registration shapes:
 *  - narrowing mockers: `installSnapshotStoreSeam({ useAllCharacters: … })` —
 *    their own narrow semantics for their own run, every other export real;
 *  - real-store riders: `installSnapshotStoreSeam()` — the real hook (with
 *    `getState`/`setState`) is live again from this registration on.
 *
 * Call `installSnapshotStoreSeam(...)` in the test-file body BEFORE importing
 * the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

/* A LOAD-TIME COPY of the real namespace (bun rewrites export slots in place on every registration; spreading the LIVE namespace inside the factory re-registers the previous mock — self-poisoning by alias, found via rail-character-browser receiving ExperienceSetupModal's `() => fakeChatList` AFTER rail's real registration, 2026-10-27). */
const realSnapshotStore = { ...(await import("../src/stores/snapshot-store.js")) };
/** The real zustand hook, captured as a bare reference BEFORE any registration — see the header. */
const realUseSnapshotStore = realSnapshotStore.useSnapshotStore;

/** Per-file overrides on top of the real namespace; the real store is the default. Keys are checked against the real module (a typo is a TS error); values are loose — they are test doubles, not the real signatures. */
export type SnapshotStoreSeamOverrides = {
	[K in keyof typeof realSnapshotStore]?: unknown;
};

/** Register the shared snapshot-store seam (re-registration simply owns the process until the next one). */
export function installSnapshotStoreSeam(overrides: SnapshotStoreSeamOverrides = {}): void {
	mock.module("../src/stores/snapshot-store.js", () => ({
		...realSnapshotStore,
		useSnapshotStore: realUseSnapshotStore,
		...overrides,
	}));
}
