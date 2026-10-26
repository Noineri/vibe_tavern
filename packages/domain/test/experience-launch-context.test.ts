import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT,
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_LAUNCH_CAPABILITIES,
  compareLaunchContext,
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

describe("compareLaunchContext", () => {
  const human = { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human };
  const modelSeat = {
    id: "ai",
    label: "AI",
    controller: EXPERIENCE_CONTROLLER.model,
    providerProfileId: "profile-1",
    modelId: "model-1",
  };
  const declaredAll = [
    EXPERIENCE_CAPABILITY.participants,
    EXPERIENCE_CAPABILITY.model,
    EXPERIENCE_CAPABILITY.deterministicRandom,
  ];

  test("a setup derived from the declared capabilities has no findings", () => {
    const derived = deriveDefaultLaunchContext(declaredAll);
    // The derived model seat has no model picked yet, so complete it the way the author would.
    const participants = derived.participants.map((seat) =>
      seat.controller === EXPERIENCE_CONTROLLER.model
        ? { ...seat, providerProfileId: "profile-1", modelId: "model-1" }
        : seat,
    );

    expect(compareLaunchContext(declaredAll, participants, derived.capabilityGrants)).toEqual({
      missingGrants: [],
      undeclaredGrants: [],
      missingModelSeat: false,
      modelSeatsWithoutModel: [],
    });
  });

  test("reports declared capabilities that are not granted", () => {
    const result = compareLaunchContext(
      declaredAll,
      [human, modelSeat],
      [EXPERIENCE_CAPABILITY.participants],
    );

    expect(result.missingGrants).toEqual([
      EXPERIENCE_CAPABILITY.model,
      EXPERIENCE_CAPABILITY.deterministicRandom,
    ]);
    expect(result.undeclaredGrants).toEqual([]);
    expect(result.missingModelSeat).toBe(false);
    expect(result.modelSeatsWithoutModel).toEqual([]);
  });

  test("reports granted capabilities the rules do not declare", () => {
    const result = compareLaunchContext(
      [EXPERIENCE_CAPABILITY.deterministicRandom],
      [human],
      [EXPERIENCE_CAPABILITY.deterministicRandom, EXPERIENCE_CAPABILITY.rpContext],
    );

    expect(result.undeclaredGrants).toEqual([EXPERIENCE_CAPABILITY.rpContext]);
    expect(result.missingGrants).toEqual([]);
    expect(result.missingModelSeat).toBe(false);
    expect(result.modelSeatsWithoutModel).toEqual([]);
  });

  test("reports a missing model seat only when the default derivation would add one", () => {
    const grants = [EXPERIENCE_CAPABILITY.participants, EXPERIENCE_CAPABILITY.model];

    expect(compareLaunchContext(grants, [human], grants).missingModelSeat).toBe(true);
    expect(compareLaunchContext(grants, [human, modelSeat], grants).missingModelSeat).toBe(false);
    expect(
      compareLaunchContext([EXPERIENCE_CAPABILITY.model], [human], [EXPERIENCE_CAPABILITY.model])
        .missingModelSeat,
    ).toBe(false);
  });

  test("reports model seats without a provider profile or a model", () => {
    const grants = [EXPERIENCE_CAPABILITY.participants, EXPERIENCE_CAPABILITY.model];
    const result = compareLaunchContext(
      grants,
      [
        human,
        { id: "ai", label: "AI", controller: EXPERIENCE_CONTROLLER.model },
        { id: "ai2", label: "Second AI", controller: EXPERIENCE_CONTROLLER.model, providerProfileId: "profile-1" },
        { ...modelSeat, id: "ai3", label: "Ready AI" },
      ],
      grants,
    );

    expect(result.modelSeatsWithoutModel).toEqual([
      { id: "ai", label: "AI" },
      { id: "ai2", label: "Second AI" },
    ]);
    expect(result.missingModelSeat).toBe(false);
  });

  test("reports all four findings together", () => {
    const result = compareLaunchContext(
      [EXPERIENCE_CAPABILITY.participants, EXPERIENCE_CAPABILITY.model],
      [human],
      [EXPERIENCE_CAPABILITY.rpAttachment],
    );

    expect(result).toEqual({
      missingGrants: [EXPERIENCE_CAPABILITY.participants, EXPERIENCE_CAPABILITY.model],
      undeclaredGrants: [EXPERIENCE_CAPABILITY.rpAttachment],
      missingModelSeat: true,
      modelSeatsWithoutModel: [],
    });
  });

  test("a model seat without a model is reported even when it is the only seat", () => {
    const result = compareLaunchContext(
      [],
      [{ id: "ai", label: "AI", controller: EXPERIENCE_CONTROLLER.model }],
      [],
    );

    expect(result.modelSeatsWithoutModel).toEqual([{ id: "ai", label: "AI" }]);
    expect(result.missingModelSeat).toBe(false);
  });
});
