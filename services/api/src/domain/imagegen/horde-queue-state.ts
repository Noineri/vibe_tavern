/** AI Horde's active queue state, keyed by profile id.
 *
 * This is run-phase.ts's twin: the generation executor and progress poll use
 * different backend instances, so transient run state must live at module
 * scope rather than on either instance. VT drives one generation at a time,
 * making one entry per profile the complete surface, with the executor's
 * finally clearing it on every exit. */

const hordeQueueStates = new Map<string, string>();

export function setHordeQueueState(profileId: string, state: string): void {
  hordeQueueStates.set(profileId, state);
}

export function getHordeQueueState(profileId: string): string | undefined {
  return hordeQueueStates.get(profileId);
}

export function clearHordeQueueState(profileId: string): void {
  hordeQueueStates.delete(profileId);
}
