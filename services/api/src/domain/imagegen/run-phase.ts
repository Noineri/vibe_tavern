/** MR-11 — one profile's live generation phase, the honest chip timeline.
 *
 * The generation executor owns the registry's lifecycle: \"starting\" is set
 * as soon as the profile resolves (covers the whole pre-submit span), the
 * assist wrapper flips it to \"prompt\" while the LLM writes the prompt and
 * back to \"starting\" when the text is ready, the backend's onJobStarted
 * callback flips it to \"steps\" once the progress surface reflects THIS
 * run's job, and the executor's finally clears the entry on every exit —
 * the chip must never inherit a stale phase into the next run.
 *
 * Module-level on purpose: the executor instance and the poll's backend
 * instance are different objects; the phase is per-profile run state, not
 * per-instance state (the comfyRunSnapshots precedent). VT drives one
 * generation at a time, so one entry per profile is the whole surface. */
import type { ImageGenJobPhase } from "./imagegen-backend.js";

const runPhases = new Map<string, ImageGenJobPhase>();

export function setImageGenRunPhase(profileId: string, phase: ImageGenJobPhase): void {
  runPhases.set(profileId, phase);
}

export function getImageGenRunPhase(profileId: string): ImageGenJobPhase | undefined {
  return runPhases.get(profileId);
}

export function clearImageGenRunPhase(profileId: string): void {
  runPhases.delete(profileId);
}
