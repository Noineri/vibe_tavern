/**
 * The ONE shared `api/persona-api.js` seam for every apps/web test file that
 * mocks a persona-api export AND every suite whose graph consumes the real
 * api (ScriptEditor's AgentShell mount lists personas for the mention
 * catalog).
 *
 * CO-LOAD CONTRACT (same discipline as test/bootstrap-actions-seam.ts and
 * test/snapshot-store-seam.ts): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled run shares the module registry in an
 * effectively arbitrary file order — so a mocking file's registration stays
 * live for every other file in the process. Reproduced 2026-10-27 (co-load
 * unit): ExperienceSetupModal's `listPersonas` mock was live during
 * ScriptEditor's tests; bun resets `mock()` implementations at file
 * boundaries, so the slot resolved `undefined` — a FULFILLED-undefined where
 * the real api would have REJECTED — and AgentShell's best-effort mention
 * catalog (`Promise.allSettled(...)` → `for (… of personas.value)`) crashed
 * 48/81 of ScriptEditor's tests in BOTH argument orders.
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP (see the bootstrap-actions seam
 * header): a rider cannot un-poison itself with the R4 spread — the captured
 * namespace's slot already holds the other file's mock. The seam captures the
 * real namespace (and the real `listPersonas` as a bare reference) ONCE, at
 * the seam module's first import — before any family member registers.
 *
 * Registration shapes:
 *  - mockers: `installPersonaApiSeam({ listPersonas: myMock })` — their own
 *    double for their own run (their own beforeEach seeds it; the reset at
 *    the file boundary only ever hits their OWN registration window);
 *  - riders: `installPersonaApiSeam()` — the real api is live again (the
 *    real fetch rejects under the test DOM, which AgentShell's
 *    allSettled path handles gracefully — the isolation behavior).
 *
 * Call `installPersonaApiSeam(...)` in the test-file body BEFORE importing
 * the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

/* A LOAD-TIME COPY of the real namespace (bun rewrites export slots in place on every registration; spreading the LIVE namespace inside the factory re-registers the previous mock — self-poisoning by alias). */
const realPersonaApi = { ...(await import("../src/api/persona-api.js")) };
/** The real api fn, captured as a bare reference BEFORE any registration — see the header. */
const realListPersonas = realPersonaApi.listPersonas;

/** Per-file overrides on top of the real namespace; the real api is the default. Keys are checked against the real module (a typo is a TS error); values are loose — they are test doubles, not the real signatures. */
export type PersonaApiSeamOverrides = {
	[K in keyof typeof realPersonaApi]?: unknown;
};

/** Register the shared persona-api seam (re-registration simply owns the process until the next one). */
export function installPersonaApiSeam(overrides: PersonaApiSeamOverrides = {}): void {
	mock.module("../src/api/persona-api.js", () => ({
		...realPersonaApi,
		listPersonas: realListPersonas,
		...overrides,
	}));
}
