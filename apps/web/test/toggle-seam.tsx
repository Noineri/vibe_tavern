/**
 * The ONE shared `components/shared/Toggle.js` seam for every apps/web test
 * file that stubs the toggle (the deterministic button with `data-checked`)
 * AND every suite that pins the REAL wrapped Radix Switch
 * (`getByRole("switch", …)` — 31 rider files).
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts and
 * test/i18n-context-seam.ts): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled run shares the module registry — so a
 * file that replaces `Toggle` with a plain `<button data-testid>` stays live
 * for EVERY later file in the process. The real-arm riders then find no
 * `role="switch"` at all: reproduced 2026-10-27 (co-load unit),
 * ExperienceCopilotShell + AgentContextMeter + AgentContextRing before
 * AgentSettingsModal — its auto-compact pins (`getByRole("switch", { name:
 * "agent_settings_autocompact" })`) went 2/2 red while each file was green
 * alone. Two of the four inline mockers (AgentContextMeter,
 * AgentContextRing) were also R4-LESS — the factory returned ONLY `Toggle`,
 * so any other export of the module would have been `undefined` for every
 * later file.
 *
 * Registration shapes:
 *  - stub suites (the meter/ring/shell family that drives the auto-compact
 *    toggle deterministically without Radix's happy-dom anchoring):
 *    `installToggleSeam({ stub: true, testId })` — their own testid on the
 *    plain button; the registration is live for their own run only.
 *  - real-arm riders: `installToggleSeam()` — the REAL Toggle (bare
 *    reference captured at seam load) is live again from this registration
 *    on, with the full real namespace spread (R4).
 *
 * The stub is the superset of the four former inline copies: `disabled` is
 * forwarded (two of the four copies did; the other two never received the
 * prop), `data-checked` mirrors `checked`, and the click flips through
 * `onChange` — the shape every stub suite's pins were written against
 * (Toggle's own behavior stays pinned in Toggle.test.tsx on the real arm).
 *
 * The DELEGATION CAPTURE RULE applies: the real `Toggle` is captured as a
 * bare function reference BEFORE any registration — bun's `mock.module`
 * replaces the module's export slots in place, so a namespace captured after
 * a stub registration would re-register the STUB (the cross-file trap the
 * bootstrap-actions seam header documents).
 *
 * Call `installToggleSeam(...)` in the test-file body BEFORE importing the
 * component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

const realToggleModule = await import("../src/components/shared/Toggle.js");
/** The real Toggle, captured as a bare reference BEFORE any registration — see the header. */
const RealToggle = realToggleModule.Toggle;

/** The stub's props — the real Toggle's behavioral surface minus the visuals. */
interface ToggleStubProps {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}

/** Per-suite registration spec. */
export interface ToggleSeamSpec {
	/** Render the deterministic plain-button stub instead of the real Radix Toggle. */
	readonly stub?: boolean;
	/** The stub's `data-testid` (each stub suite keeps its own pin). */
	readonly testId?: string;
}

/** Register the shared Toggle seam (re-registration simply owns the process until the next one). */
export function installToggleSeam(spec: ToggleSeamSpec = {}): void {
	const stubWanted = spec.stub === true;
	const testId = spec.testId ?? "copilot-context-autocompact-toggle";
	mock.module("../src/components/shared/Toggle.js", () => ({
		...realToggleModule,
		Toggle: stubWanted
			? function ToggleSeamStub({ checked, onChange, disabled }: ToggleStubProps) {
					return (
						<button
							type="button"
							data-testid={testId}
							data-checked={checked ? "true" : "false"}
							disabled={disabled}
							onClick={() => onChange(!checked)}
						/>
					);
				}
			: RealToggle,
	}));
}
