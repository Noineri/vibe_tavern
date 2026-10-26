import type { ExperienceParticipant } from "./entities.js";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  type ExperienceCapability,
} from "./platform-constants.js";

export interface DefaultExperienceLaunchContext {
  participants: ExperienceParticipant[];
  capabilityGrants: ExperienceCapability[];
}

export const EXPERIENCE_LAUNCH_CAPABILITIES = [
  EXPERIENCE_CAPABILITY.participants,
  EXPERIENCE_CAPABILITY.deterministicRandom,
  EXPERIENCE_CAPABILITY.model,
  EXPERIENCE_CAPABILITY.rpContext,
  EXPERIENCE_CAPABILITY.rpAttachment,
] as const;

const KNOWN_CAPABILITIES = new Set<string>(EXPERIENCE_LAUNCH_CAPABILITIES);

function isExperienceCapability(capability: string): capability is ExperienceCapability {
  return KNOWN_CAPABILITIES.has(capability);
}

export const DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT: Readonly<DefaultExperienceLaunchContext> = {
  participants: [
    { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
  ],
  capabilityGrants: [],
};

/** Derive the Try sandbox's untouched roster and grants from discovered rules. */
export function deriveDefaultLaunchContext(
  declaredCapabilities: readonly string[],
): DefaultExperienceLaunchContext {
  const capabilityGrants = declaredCapabilities.filter(isExperienceCapability);
  const participants: ExperienceParticipant[] = [
    ...DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT.participants,
  ];

  if (
    capabilityGrants.includes(EXPERIENCE_CAPABILITY.participants)
    && capabilityGrants.includes(EXPERIENCE_CAPABILITY.model)
  ) {
    participants.push({ id: "ai", label: "AI", controller: EXPERIENCE_CONTROLLER.model });
  }

  return { participants, capabilityGrants };
}

export interface LaunchContextComparison {
  /** Declared capabilities the setup does not grant. */
  missingGrants: ExperienceCapability[];
  /** Granted capabilities the rules do not declare (every explicit run fails with `capability_denied`). */
  undeclaredGrants: ExperienceCapability[];
  /** True when the default derivation would add a model seat and the roster has none. */
  missingModelSeat: boolean;
  /** Model seats lacking a provider profile or a model id. */
  modelSeatsWithoutModel: Array<{ id: string; label: string }>;
}

/** Compare a Try setup (roster + grants) with what the discovered rules declare.
 *  The model-seat expectation comes from {@link deriveDefaultLaunchContext}, never a second hand-written rule. */
export function compareLaunchContext(
  declaredCapabilities: readonly string[],
  participants: readonly ExperienceParticipant[],
  grants: readonly ExperienceCapability[],
): LaunchContextComparison {
  const derived = deriveDefaultLaunchContext(declaredCapabilities);
  const expectsModelSeat = derived.participants.some(
    (participant) => participant.controller === EXPERIENCE_CONTROLLER.model,
  );
  const modelSeats = participants.filter(
    (participant) => participant.controller === EXPERIENCE_CONTROLLER.model,
  );

  return {
    missingGrants: derived.capabilityGrants.filter((capability) => !grants.includes(capability)),
    undeclaredGrants: grants.filter((capability) => !declaredCapabilities.includes(capability)),
    missingModelSeat: expectsModelSeat && modelSeats.length === 0,
    modelSeatsWithoutModel: modelSeats
      .filter((seat) => !seat.providerProfileId || !seat.modelId)
      .map((seat) => ({ id: seat.id, label: seat.label })),
  };
}
