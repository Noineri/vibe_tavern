/**
 * PD-3 pin — the wizard's provider form seed reads the one domain source:
 * a brand-new profile carries PROVIDER_PROFILE_GENERATION_DEFAULTS for every
 * generation field it seeds (contextBudget is the web's named 16000), and an
 * existing profile's own values still win.
 */
import { describe, expect, it } from "bun:test";

import { PROVIDER_PROFILE_GENERATION_DEFAULTS } from "@vibe-tavern/domain";
import { wireProviderProfile } from "../../../test/wire-fixtures.js";
import type { FormState } from "../modals/ProviderModal.js";
import { buildWizardFormSeed } from "./setup-wizard-form-seed.js";

const D = PROVIDER_PROFILE_GENERATION_DEFAULTS;

describe("buildWizardFormSeed", () => {
  it("seeds a brand-new profile from the domain generation defaults", () => {
    const seed = buildWizardFormSeed(null);
    const { contextBudget: _budget, ...generationDefaults } = D;
    for (const [key, value] of Object.entries(generationDefaults)) {
      // Fields the wizard form does not seed (e.g. thinkingMode, unified*) are skipped.
      if (!(key in seed)) continue;
      // The `in` guard above is the runtime proof for this key narrowing: the
      // reflective loop reads one dynamically-checked member of the seed.
      expect([key, seed[key as keyof FormState]]).toEqual([key, value]);
    }
    expect(seed.contextBudget).toBe(16000);
    expect(seed.maxTokens).toBe(2000);
    expect(seed.temperature).toBe(1);
    expect(seed.reasoningEffort).toBe("auto");
  });

  it("lets an existing profile's own values win", () => {
    // The complete wire row (the ONE ProviderProfileRecord derivation) with
    // the pins the erased partial literal carried — the fields this function
    // reads are exactly the overridden ones, so the boundary is unchanged.
    const seed = buildWizardFormSeed(
      wireProviderProfile({
        id: "p1", name: "Mine", temperature: 0.3, maxTokens: 777, contextBudget: 4096, reasoningEffort: "high", stopSequences: ["x"],
      }),
    );
    expect(seed.temperature).toBe(0.3);
    expect(seed.maxTokens).toBe(777);
    expect(seed.contextBudget).toBe(4096);
    expect(seed.reasoningEffort).toBe("high");
    expect(seed.stopSequences).toEqual(["x"]);
  });

  it("does not hand out the domain constant's arrays (mutating the seed cannot corrupt the defaults)", () => {
    const seed = buildWizardFormSeed(null);
    expect(seed.stopSequences).not.toBe(D.stopSequences);
    expect(seed.bannedStrings).not.toBe(D.bannedStrings);
    expect(seed.logitBias).not.toBe(D.logitBias);
    expect(seed.drySequenceBreakers).not.toBe(D.drySequenceBreakers);
  });
});
