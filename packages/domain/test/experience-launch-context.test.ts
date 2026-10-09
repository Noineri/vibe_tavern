import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT,
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_LAUNCH_CAPABILITIES,
  deriveDefaultLaunchContext,
  type ExperienceCapability,
} from "../src/index.js";

function capabilitySubsets(): ExperienceCapability[][] {
  return Array.from({ length: 1 << EXPERIENCE_LAUNCH_CAPABILITIES.length }, (_, mask) =>
    EXPERIENCE_LAUNCH_CAPABILITIES.filter((_, index) => (mask & (1 << index)) !== 0),
  );
}

describe("deriveDefaultLaunchContext", () => {
  test("preserves the current default grants and roster for every supported capability subset", () => {
    for (const declaredCapabilities of capabilitySubsets()) {
      const result = deriveDefaultLaunchContext(declaredCapabilities);

      expect(result.capabilityGrants).toEqual(declaredCapabilities);
      expect(result.participants).toEqual(
        declaredCapabilities.includes(EXPERIENCE_CAPABILITY.participants)
          && declaredCapabilities.includes(EXPERIENCE_CAPABILITY.model)
          ? [
              { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
              { id: "ai", label: "AI", controller: EXPERIENCE_CONTROLLER.model },
            ]
          : [{ id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human }],
      );
    }
  });

  test("filters unknown capabilities and exposes the discovery-failure fallback", () => {
    expect(deriveDefaultLaunchContext(["participants", "unknown", "deterministic_random"]))
      .toEqual({
        participants: [
          { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
        ],
        capabilityGrants: ["participants", "deterministic_random"],
      });
    expect(DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT).toEqual({
      participants: [
        { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
      ],
      capabilityGrants: [],
    });
  });
});
