/**
 * The ONE shared `agent-shell/AgentSkillModal.js` seam for the two files that
 * touch the module in a co-loadable bundle: AgentSettingsModal.test.tsx
 * (stubs the modal to a thin `settings-child-skill` shell so the gear → modal
 * wiring stays observable) and AgentSkillModal.test.tsx itself (the modal's
 * OWN suite — renders the REAL component).
 *
 * CO-LOAD CONTRACT (same discipline as the store/api seams): `mock.module` is
 * process-global and last-write-wins, and a hand-bundled run shares the
 * module registry — so when AgentSettingsModal's registration is live at
 * AgentSkillModal.test's load, the suite's `await import("./AgentSkillModal.js")`
 * destructures the STUB and every catalog `waitFor` times out (11/22 red,
 * each file green alone; reproduced 2026-10-27, co-load unit — the rendered
 * DOM literally contained the stub's `settings-child-skill-back-btn`).
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP (see test/bootstrap-actions-seam.ts):
 * the victim cannot un-poison itself — its own capture would import the stub.
 * The seam captures the real namespace ONCE at its first import (before any
 * family member registers) and re-registers it verbatim for the victim:
 *  - stubber: `installAgentSkillModalSeam({ AgentSkillModal: myStub })`;
 *  - the modal's own suite: `installAgentSkillModalSeam()` — the REAL
 *    component is live again from this registration on.
 *
 * Call it in the test-file body BEFORE importing the component under test.
 */
import { mock } from "bun:test";
import type { ComponentType } from "react";

const realSkillModalModule = await import("../src/components/shared/agent-shell/AgentSkillModal.js");
/** The real component, captured as a bare reference BEFORE any registration. */
const RealAgentSkillModal = realSkillModalModule.AgentSkillModal;

/** Per-file overrides; keys are checked, values are loose (test doubles). */
export type AgentSkillModalSeamOverrides = {
	[K in keyof typeof realSkillModalModule]?: unknown;
};

/** Register the shared AgentSkillModal seam (re-registration owns the process until the next one). */
export function installAgentSkillModalSeam(overrides: AgentSkillModalSeamOverrides = {}): void {
	mock.module("../src/components/shared/agent-shell/AgentSkillModal.js", () => ({
		...realSkillModalModule,
		AgentSkillModal: RealAgentSkillModal as ComponentType<never>,
		...overrides,
	}));
}
