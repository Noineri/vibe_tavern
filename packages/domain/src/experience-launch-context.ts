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
