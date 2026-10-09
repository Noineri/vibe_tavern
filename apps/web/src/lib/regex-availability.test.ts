/**
 * Exhaustive precedence table for the RXU-31 availability model.
 *
 * Pins: every Profile/Rule status cell, the unknown-vs-confirmed-zero link
 * distinction (unknown is `loading`, never `unbound`), the global boundary
 * (enabled+global+zero links is NOT `unbound`), member dormant-own-links
 * ineffectiveness, and enabled-only member counting.
 */

import { describe, expect, it } from "bun:test";
import {
  regexProfileAvailability,
  regexRuleAvailability,
  type RegexRuleAvailabilityInput,
} from "./regex-availability.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../api/types.js";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";

function baseRule(overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>("r1"),
    name: "Rule",
    findRegex: "/foo/g",
    replaceString: "bar",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    profileId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseProfile(overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>("p1"),
    name: "Profile",
    disabled: false,
    isGlobal: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const P1 = brandId<RegexProfileId>("p1");
const P2 = brandId<RegexProfileId>("p2");

function standaloneInput(overrides: Partial<RegexRuleAvailabilityInput> = {}): RegexRuleAvailabilityInput {
  return { rule: baseRule(), ruleLinkCount: undefined, profile: null, profileLinkCount: undefined, ...overrides };
}

describe("regexProfileAvailability — precedence table", () => {
  it("disabled wins over everything (non-global, zero links, enabled members present)", () => {
    const profile = baseProfile({ disabled: true });
    const rules = [baseRule({ profileId: P1 }), baseRule({ id: brandId<RegexPresetId>("r2"), profileId: P1 })];
    expect(regexProfileAvailability(profile, rules, 0)).toEqual({ kind: "disabled" });
  });

  it("enabled non-global with CONFIRMED zero links is unbound (even with enabled members)", () => {
    const rules = [baseRule({ profileId: P1 })];
    expect(regexProfileAvailability(baseProfile(), rules, 0)).toEqual({ kind: "unbound" });
  });

  it("enabled non-global with UNKNOWN links is loading, never unbound", () => {
    expect(regexProfileAvailability(baseProfile(), [], undefined)).toEqual({ kind: "loading" });
  });

  it("BOUNDARY: enabled + global + zero links is NOT unbound — falls through to member logic", () => {
    expect(regexProfileAvailability(baseProfile({ isGlobal: true }), [], 0)).toEqual({ kind: "noEnabledRules" });
  });

  it("enabled + global + unknown links is not loading — global skips the link check", () => {
    const rules = [baseRule({ profileId: P1 })];
    expect(regexProfileAvailability(baseProfile({ isGlobal: true }), rules, undefined)).toEqual({ kind: "active", enabledRuleCount: 1 });
  });

  it("bound profile with zero enabled members is noEnabledRules", () => {
    const rules = [baseRule({ profileId: P1, disabled: true })];
    expect(regexProfileAvailability(baseProfile(), rules, 2)).toEqual({ kind: "noEnabledRules" });
  });

  it("global profile whose members are all disabled is noEnabledRules", () => {
    const rules = [
      baseRule({ profileId: P1, disabled: true }),
      baseRule({ id: brandId<RegexPresetId>("r2"), profileId: P1, disabled: true }),
    ];
    expect(regexProfileAvailability(baseProfile({ isGlobal: true }), rules, 0)).toEqual({ kind: "noEnabledRules" });
  });

  it("active counts ENABLED members only", () => {
    const rules = [
      baseRule({ profileId: P1 }),
      baseRule({ id: brandId<RegexPresetId>("r2"), profileId: P1 }),
      baseRule({ id: brandId<RegexPresetId>("r3"), profileId: P1, disabled: true }),
    ];
    expect(regexProfileAvailability(baseProfile({ isGlobal: true }), rules, 0)).toEqual({ kind: "active", enabledRuleCount: 2 });
  });

  it("active counts only THIS profile's members — other profiles' and standalone rules excluded", () => {
    const rules = [
      baseRule({ profileId: P1 }),
      baseRule({ id: brandId<RegexPresetId>("r2"), profileId: P2 }),
      baseRule({ id: brandId<RegexPresetId>("r3"), profileId: null }),
    ];
    expect(regexProfileAvailability(baseProfile(), rules, 1)).toEqual({ kind: "active", enabledRuleCount: 1 });
  });

  it("precedence: unbound beats noEnabledRules (zero members AND confirmed zero links)", () => {
    expect(regexProfileAvailability(baseProfile(), [], 0)).toEqual({ kind: "unbound" });
  });
});

describe("regexRuleAvailability — standalone", () => {
  it("disabled rule is disabled regardless of links or global", () => {
    expect(regexRuleAvailability(standaloneInput({ rule: baseRule({ disabled: true }), ruleLinkCount: 0 })))
      .toEqual({ kind: "disabled", profile: null });
  });

  it("enabled non-global with CONFIRMED zero links is unbound", () => {
    expect(regexRuleAvailability(standaloneInput({ ruleLinkCount: 0 }))).toEqual({ kind: "unbound", profile: null });
  });

  it("enabled non-global with UNKNOWN links is loading, never unbound", () => {
    expect(regexRuleAvailability(standaloneInput({ ruleLinkCount: undefined }))).toEqual({ kind: "loading", profile: null });
  });

  it("BOUNDARY: enabled + global + zero links is active, not unbound", () => {
    expect(regexRuleAvailability(standaloneInput({ rule: baseRule({ isGlobal: true }), ruleLinkCount: 0 })))
      .toEqual({ kind: "active", profile: null });
  });

  it("enabled + global + unknown links is active, not loading", () => {
    expect(regexRuleAvailability(standaloneInput({ rule: baseRule({ isGlobal: true }), ruleLinkCount: undefined })))
      .toEqual({ kind: "active", profile: null });
  });

  it("enabled non-global with links is active", () => {
    expect(regexRuleAvailability(standaloneInput({ ruleLinkCount: 3 }))).toEqual({ kind: "active", profile: null });
  });
});

describe("regexRuleAvailability — member", () => {
  const identity = { id: P1, name: "Profile" };

  it("own disabled wins even when the profile fires everywhere", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1, disabled: true }),
      ruleLinkCount: 5,
      profile: baseProfile({ isGlobal: true }),
      profileLinkCount: 0,
    })).toEqual({ kind: "disabled", profile: identity });
  });

  it("profile disabled makes the member disabled (own enabled)", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1 }),
      ruleLinkCount: 5,
      profile: baseProfile({ disabled: true }),
      profileLinkCount: 0,
    })).toEqual({ kind: "disabled", profile: identity });
  });

  it("profile enabled non-global with CONFIRMED zero links is unbound — own dormant links are NOT effective", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1, isGlobal: true }),
      ruleLinkCount: 4,
      profile: baseProfile(),
      profileLinkCount: 0,
    })).toEqual({ kind: "unbound", profile: identity });
  });

  it("profile enabled non-global with UNKNOWN links is loading, never unbound", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1 }),
      ruleLinkCount: undefined,
      profile: baseProfile(),
      profileLinkCount: undefined,
    })).toEqual({ kind: "loading", profile: identity });
  });

  it("global profile member is active regardless of its own dormant global flag and links", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1, isGlobal: true }),
      ruleLinkCount: 0,
      profile: baseProfile({ isGlobal: true }),
      profileLinkCount: undefined,
    })).toEqual({ kind: "active", profile: identity });
  });

  it("bound profile member is active and carries the profile identity", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1 }),
      ruleLinkCount: undefined,
      profile: baseProfile(),
      profileLinkCount: 2,
    })).toEqual({ kind: "active", profile: { id: P1, name: "Profile" } });
  });

  it("dangling membership (profile record missing) keeps the pre-RXU-31 fallback: own state only, identity null", () => {
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1 }),
      ruleLinkCount: 0,
      profile: null,
      profileLinkCount: undefined,
    })).toEqual({ kind: "active", profile: null });
    expect(regexRuleAvailability({
      rule: baseRule({ profileId: P1, disabled: true }),
      ruleLinkCount: 0,
      profile: null,
      profileLinkCount: undefined,
    })).toEqual({ kind: "disabled", profile: null });
  });
});
