/**
 * The ONE shared `stores/experience-store.js` seam for every apps/web test
 * file that narrows the store (ExperienceSetupModal, ExperienceLauncher —
 * the hand-rolled `useExperienceStore` object with a `getState` returning the
 * file's fake state; InsightsPanel/ExperienceDetachedWindow/dice-panel when
 * they join a bundle) AND every suite whose graph consumes the real store.
 *
 * CO-LOAD CONTRACT (same discipline as test/bootstrap-actions-seam.ts and
 * test/snapshot-store-seam.ts): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled run shares the module registry in an
 * effectively arbitrary file order — so a narrowing registration stays live
 * for every other file in the process. Reproduced 2026-10-27 (co-load unit):
 * with ExperienceSetupModal's narrow `useExperienceStore` live, a STALE
 * ExperienceSetupModal passive effect (React 19 flushes it into the NEXT
 * file's phase) called the narrow `getState` during rail-character-browser's
 * run and broke 11 of its row/list pins (`rail_no_chats`, character order);
 * with the REAL store restored the same stale effect is harmless (the
 * de-narrowed bisect ran rail 0-fail). Both contributors are named: the leak
 * lives in the stubbing file's own unmount/drain window, the POISON is the
 * narrow object staying live — this seam removes the poison for every rider.
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP (see the bootstrap-actions seam
 * header): a rider cannot un-poison itself with the R4 spread. The seam
 * captures the real namespace once, at the seam module's first import.
 *
 * Registration shapes:
 *  - narrowing mockers: `installExperienceStoreSeam({ useExperienceStore:
 *    myFakeStore, … })` — their own doubles for their own run;
 *  - riders: `installExperienceStoreSeam()` — the real store is live again.
 *
 * Call `installExperienceStoreSeam(...)` in the test-file body BEFORE
 * importing the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

/* A LOAD-TIME COPY of the real namespace (bun rewrites export slots in place on every registration; spreading the LIVE namespace inside the factory re-registers the previous mock — self-poisoning by alias). */
const realExperienceStore = { ...(await import("../src/stores/experience-store.js")) };
/** The real store object, captured as a bare reference BEFORE any registration. */
const realUseExperienceStore = realExperienceStore.useExperienceStore;

/** Per-file overrides on top of the real namespace; the real store is the default. Keys are checked against the real module (a typo is a TS error); values are loose — they are test doubles, not the real signatures. */
export type ExperienceStoreSeamOverrides = {
	[K in keyof typeof realExperienceStore]?: unknown;
};

/** Register the shared experience-store seam (re-registration simply owns the process until the next one). */
export function installExperienceStoreSeam(overrides: ExperienceStoreSeamOverrides = {}): void {
	mock.module("../src/stores/experience-store.js", () => ({
		...realExperienceStore,
		useExperienceStore: realUseExperienceStore,
		...overrides,
	}));
}
