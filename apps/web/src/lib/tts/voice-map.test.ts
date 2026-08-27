import { describe, expect, test } from "bun:test";

import type { TtsLinkRecord, TtsProfileRecord } from "../../api/tts-api.js";
import { resolveNarrationProfile } from "./voice-map.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Profile 1",
    backend: "kokoro",
    config: {},
    voiceId: "af_heart",
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function link(overrides: Partial<TtsLinkRecord> = {}): TtsLinkRecord {
  return {
    ttsProfileId: "p1",
    targetType: "character",
    targetId: "char_1",
    mode: "voice",
    ...overrides,
  };
}

describe("resolveNarrationProfile", () => {
  test("1. disabled on character wins over voice link and default", () => {
    const profiles = [profile({ id: "p1", isDefault: true }), profile({ id: "p2", name: "Other" })];
    const links: TtsLinkRecord[] = [
      link({ ttsProfileId: "p2", targetId: "char_1", mode: "voice" }),
      link({ ttsProfileId: "p1", targetId: "char_1", mode: "disabled" }),
    ];
    const result = resolveNarrationProfile(profiles, links, { characterId: "char_1" });
    expect(result.kind).toBe("disabled");
  });

  test("1. disabled on persona alone returns disabled", () => {
    const profiles = [profile({ id: "p1", isDefault: true })];
    const links: TtsLinkRecord[] = [link({ ttsProfileId: "p1", targetId: "persona_1", targetType: "persona", mode: "disabled" })];
    const result = resolveNarrationProfile(profiles, links, { personaId: "persona_1" });
    expect(result.kind).toBe("disabled");
  });

  test("2. character voice link wins over persona link and default", () => {
    const charProfile = profile({ id: "p_char", name: "Char", sortOrder: 10 });
    const personaProfile = profile({ id: "p_persona", name: "Persona", sortOrder: 0 });
    const defaultProfile = profile({ id: "p_def", name: "Default", isDefault: true });
    const profiles = [charProfile, personaProfile, defaultProfile];
    const links: TtsLinkRecord[] = [
      link({ ttsProfileId: "p_char", targetId: "char_1", targetType: "character", mode: "voice" }),
      link({ ttsProfileId: "p_persona", targetId: "persona_1", targetType: "persona", mode: "voice" }),
    ];
    const result = resolveNarrationProfile(profiles, links, { characterId: "char_1", personaId: "persona_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_char");
  });

  test("2. persona link wins over default when no character link", () => {
    const personaProfile = profile({ id: "p_persona", name: "Persona" });
    const defaultProfile = profile({ id: "p_def", name: "Default", isDefault: true });
    const profiles = [personaProfile, defaultProfile];
    const links: TtsLinkRecord[] = [link({ ttsProfileId: "p_persona", targetId: "persona_1", targetType: "persona", mode: "voice" })];
    const result = resolveNarrationProfile(profiles, links, { characterId: "char_1", personaId: "persona_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_persona");
  });

  test("3. default profile used when no links match; none when no default", () => {
    const defaultProfile = profile({ id: "p_def", isDefault: true });
    const other = profile({ id: "p_other", name: "Other" });
    const profilesWithDefault = [other, defaultProfile];
    const profilesWithoutDefault = [other];

    const noneLinks: TtsLinkRecord[] = [];

    const withDefault = resolveNarrationProfile(profilesWithDefault, noneLinks, { characterId: "char_1" });
    expect(withDefault.kind).toBe("profile");
    if (withDefault.kind === "profile") expect(withDefault.profile.id).toBe("p_def");

    const none = resolveNarrationProfile(profilesWithoutDefault, noneLinks, { characterId: "char_1" });
    expect(none.kind).toBe("none");
  });

  test("4. multi-binding tie-break: isDefault first, then lowest sortOrder, then name ASC", () => {
    const pDefault = profile({ id: "p_def", name: "Zebra", isDefault: true, sortOrder: 10 });
    const pLowOrder = profile({ id: "p_low", name: "Low", sortOrder: 0 });
    const pHighOrder = profile({ id: "p_high", name: "High", sortOrder: 5 });
    const pAlpha = profile({ id: "p_alpha", name: "Alpha", sortOrder: 5 });
    const pBeta = profile({ id: "p_beta", name: "Beta", sortOrder: 5 });

    // isDefault wins
    let profiles = [pLowOrder, pDefault, pHighOrder];
    let links: TtsLinkRecord[] = [
      link({ ttsProfileId: "p_low", targetId: "char_1" }),
      link({ ttsProfileId: "p_def", targetId: "char_1" }),
      link({ ttsProfileId: "p_high", targetId: "char_1" }),
    ];
    let result = resolveNarrationProfile(profiles, links, { characterId: "char_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_def");

    // neither default -> lowest sortOrder wins
    profiles = [pLowOrder, pHighOrder, pAlpha];
    links = [
      link({ ttsProfileId: "p_low", targetId: "char_1" }),
      link({ ttsProfileId: "p_high", targetId: "char_1" }),
      link({ ttsProfileId: "p_alpha", targetId: "char_1" }),
    ];
    result = resolveNarrationProfile(profiles, links, { characterId: "char_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_low");

    // equal sortOrder -> name ASC
    profiles = [pBeta, pAlpha];
    links = [
      link({ ttsProfileId: "p_beta", targetId: "char_1" }),
      link({ ttsProfileId: "p_alpha", targetId: "char_1" }),
    ];
    result = resolveNarrationProfile(profiles, links, { characterId: "char_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_alpha");
  });

  test("5. stale link (profileId not in profiles) is ignored", () => {
    const real = profile({ id: "p_real", name: "Real" });
    const profiles = [real];
    const links: TtsLinkRecord[] = [
      link({ ttsProfileId: "p_stale", targetId: "char_1" }),
      link({ ttsProfileId: "p_real", targetId: "persona_1", targetType: "persona" }),
    ];
    // char link is stale -> falls through to persona
    const result = resolveNarrationProfile(profiles, links, { characterId: "char_1", personaId: "persona_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p_real");

    // only stale char link, no persona/default -> none
    const onlyStale: TtsLinkRecord[] = [link({ ttsProfileId: "p_stale", targetId: "char_1" })];
    const none = resolveNarrationProfile(profiles, onlyStale, { characterId: "char_1" });
    expect(none.kind).toBe("none");
  });

  test("6. missing mode on the wire record is treated as voice", () => {
    const prof = profile({ id: "p1", name: "P1" });
    const linksMissingMode = [{ ttsProfileId: "p1", targetType: "character", targetId: "char_1" } as TtsLinkRecord];
    // No explicit mode -> should be treated as voice, so it resolves
    const result = resolveNarrationProfile([prof], linksMissingMode, { characterId: "char_1" });
    expect(result.kind).toBe("profile");
    if (result.kind === "profile") expect(result.profile.id).toBe("p1");

    // Missing mode should NOT trigger disabled
    const notDisabled = resolveNarrationProfile([], linksMissingMode, { characterId: "char_1" });
    // No profile for persona, but link points to char; with missing mode it's voice, not disabled
    // Since prof exists above, we already tested voice. Here with no profiles, character link is voice but stale? Actually p1 not in [] -> none, not disabled
    expect(notDisabled.kind).toBe("none");
  });

  test("6. missing mode disabled semantics: explicit disabled still wins", () => {
    const prof = profile({ id: "p1" });
    const links: TtsLinkRecord[] = [
      { ttsProfileId: "p1", targetType: "character", targetId: "char_1" } as TtsLinkRecord,
      link({ ttsProfileId: "p1", targetId: "char_1", mode: "disabled" }),
    ];
    const result = resolveNarrationProfile([prof], links, { characterId: "char_1" });
    expect(result.kind).toBe("disabled");
  });

});
