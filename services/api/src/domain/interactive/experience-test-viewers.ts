import {
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_VIEWER_KIND,
  type ExperienceParticipant,
  type ExperienceViewer,
} from "@vibe-tavern/domain";

export function viewerKindForController(controller: string): ExperienceViewer["kind"] {
  if (controller === EXPERIENCE_CONTROLLER.human) return EXPERIENCE_VIEWER_KIND.human;
  if (controller === EXPERIENCE_CONTROLLER.script) return EXPERIENCE_VIEWER_KIND.script;
  if (controller === EXPERIENCE_CONTROLLER.model) return EXPERIENCE_VIEWER_KIND.model;
  return EXPERIENCE_VIEWER_KIND.observer;
}

/** Resolve the response viewer from the selected sandbox seat, then a human. */
export function resolveProjectionViewer(
  participants: readonly ExperienceParticipant[],
  participantId?: string,
): ExperienceViewer {
  const selected = participantId === undefined
    ? undefined
    : participants.find((participant) => participant.id === participantId);
  if (selected !== undefined) {
    return { kind: viewerKindForController(selected.controller), participantId: selected.id };
  }
  const human = participants.find((participant) => participant.controller === EXPERIENCE_CONTROLLER.human);
  return human !== undefined
    ? { kind: EXPERIENCE_VIEWER_KIND.human, participantId: human.id }
    : { kind: EXPERIENCE_VIEWER_KIND.observer };
}

/** Resolve an action's named seat, falling back to the response viewer. */
export function resolveViewerForAction(
  participants: readonly ExperienceParticipant[],
  participantId?: string,
): ExperienceViewer {
  if (participantId !== undefined) {
    const participant = participants.find((seat) => seat.id === participantId);
    if (participant !== undefined) {
      return {
        kind: viewerKindForController(participant.controller),
        participantId: participant.id,
      };
    }
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId };
  }
  return resolveProjectionViewer(participants);
}
