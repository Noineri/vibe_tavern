/** Runtime contract for the stateless unsaved-source experience tester —
 *  extracted from runtime-api.ts for the size ratchet; `ExperienceRuntimeApi`
 *  extends it so every existing consumer keeps resolving the same members. */

// ─── Stateless unsaved-source tester (Wave 8 / IR-81B) ───────────────────────

import type {
	ExperienceTestDiscoverData,
	ExperienceTestRunData,
	ExperienceTestRunInput,
	ExperienceTestSimulateData,
	ExperienceTestSimulateInput,
} from "../../domain/interactive/experience-tester.js";

export interface ExperienceTesterRuntimeApi {
	/** Drive UNSAVED rules source through the real sandbox/kernel with zero
	 *  persistence and zero chat/session/DB binding: discover + create + project
	 *  + legal actions, then replay an ordered action list with the host managing
	 *  the in-memory revision counter, requestId idempotency, and expectedRevision
	 *  compare-and-swap. Authoritative only over its own ephemeral state. */
	runExperienceTest: (body: ExperienceTestRunInput) => Promise<ExperienceTestRunData>;
	/** Discover + create, then run a bounded automated simulation advancing
	 *  script-controlled seats via the real `choose` until a human/model boundary,
	 *  a terminal status, no legal action, or a host bound is reached. Returns a
	 *  typed stop-reason diagnostic per case. */
	simulateExperienceTest: (body: ExperienceTestSimulateInput) => Promise<ExperienceTestSimulateData>;
	/** Discover-only: collect the registration from the rules BODY and return the
	 *  definition, never calling `create` and granting no capability — the safe
	 *  source of the Try tab's launch-context derivation. */
	discoverExperienceTest: (body: { rulesCode: string; scriptName?: string }) => Promise<ExperienceTestDiscoverData>;
}
