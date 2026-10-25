/**
 * The ONE shared `api/copilot-skill-api.js` seam for every apps/web test file
 * that mocks a skill-api export (AgentProfileModal, AgentSettingsModal,
 * AgentSkillModal — the agent-shell trio — plus the store/api suites when
 * they join a bundle).
 *
 * CO-LOAD CONTRACT (same discipline as test/bootstrap-actions-seam.ts,
 * test/snapshot-store-seam.ts, test/persona-api-seam.ts): `mock.module` is
 * process-global and last-write-wins, and a hand-bundled run shares the
 * module registry in an effectively arbitrary file order. Reproduced
 * 2026-10-27 (co-load unit): AgentSettingsModal's `listCopilotSkills` mock
 * was live during AgentSkillModal's tests (its own registration had been
 * replaced at AgentSettingsModal's load) — bun resets `mock()`
 * implementations at file boundaries, so the slot resolved `undefined`, the
 * catalog `waitFor` never settled, and 11 of AgentSkillModal's tests timed
 * out while each file was green alone.
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP (see the bootstrap-actions seam
 * header): a rider cannot un-poison itself with the R4 spread. The seam
 * captures the real namespace once, at the seam module's first import —
 * before any family member registers.
 *
 * Registration shapes:
 *  - mockers: `installCopilotSkillApiSeam({ listCopilotSkills: myMock, … })` —
 *    their own doubles for their own run (their own beforeEach seeds them);
 *  - riders: `installCopilotSkillApiSeam()` — the real api is live again.
 *
 * Call `installCopilotSkillApiSeam(...)` in the test-file body BEFORE
 * importing the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

/* A LOAD-TIME COPY of the real namespace (bun rewrites export slots in place on every registration; spreading the LIVE namespace inside the factory re-registers the previous mock — self-poisoning by alias). */
const realSkillApi = { ...(await import("../src/api/copilot-skill-api.js")) };

/** Per-file overrides on top of the real namespace; the real api is the default. Keys are checked against the real module (a typo is a TS error); values are loose — they are test doubles, not the real signatures. */
export type CopilotSkillApiSeamOverrides = {
	[K in keyof typeof realSkillApi]?: unknown;
};

/** Register the shared copilot-skill-api seam (re-registration simply owns the process until the next one). */
export function installCopilotSkillApiSeam(overrides: CopilotSkillApiSeamOverrides = {}): void {
	mock.module("../src/api/copilot-skill-api.js", () => ({
		...realSkillApi,
		...overrides,
	}));
}
