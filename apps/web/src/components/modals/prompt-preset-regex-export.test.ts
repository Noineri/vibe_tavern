import { describe, expect, test } from "bun:test";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import type { RegexPresetRecord, RegexProfileRecord } from "../../api/types.js";
import { resolvePromptPresetExportRules } from "./prompt-preset-regex-export.js";

function rule(
  id: string,
  name: string,
  profileId: string | null = null,
  overrides: Partial<RegexPresetRecord> = {},
): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>(id),
    name,
    findRegex: "/find/g",
    replaceString: "replace",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    profileId: profileId === null ? null : brandId<RegexProfileId>(profileId),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function profile(id: string, name: string, overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>(id),
    name,
    disabled: false,
    isGlobal: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function resolve(
  rules: RegexPresetRecord[],
  profiles: RegexProfileRecord[],
  rulePresetIds: string[] = [],
  profilePresetIds: string[] = [],
) {
  return resolvePromptPresetExportRules({
    presetId: "preset-1",
    rules,
    profiles,
    getRuleLinks: async (id) => rulePresetIds.includes(id)
      ? [{ regexPresetId: brandId<RegexPresetId>(id), targetType: "preset", targetId: "preset-1" }]
      : [],
    getProfileLinks: async (id) => profilePresetIds.includes(id)
      ? [{ regexProfileId: brandId<RegexProfileId>(id), targetType: "preset", targetId: "preset-1" }]
      : [],
  });
}

describe("resolvePromptPresetExportRules", () => {
  test("includes a directly linked standalone Rule", async () => {
    const direct = rule("direct", "Direct");

    expect(await resolve([direct], [], ["direct"])).toEqual([direct]);
  });

  test("includes every member of a directly linked Profile, including disabled Rules", async () => {
    const bundle = profile("bundle", "Bundle");
    const enabled = rule("enabled", "Enabled", "bundle");
    const disabled = rule("disabled", "Disabled", "bundle", { disabled: true, sortOrder: 1 });

    const exported = await resolve([enabled, disabled], [bundle], [], ["bundle"]);

    expect(exported).toEqual([enabled, disabled]);
    expect(exported[1]?.disabled).toBe(true);
  });

  test("excludes global-only standalone reachability", async () => {
    const global = rule("global", "Global", null, { isGlobal: true });

    expect(await resolve([global], [])).toEqual([]);
  });

  test("excludes a member Rule's dormant preset link when its Profile is not linked", async () => {
    const bundle = profile("bundle", "Unlinked bundle");
    const member = rule("member", "Dormant direct link", "bundle");

    expect(await resolve([member], [bundle], ["member"])).toEqual([]);
  });

  test("excludes Rules in unlinked Profiles", async () => {
    const bundle = profile("bundle", "Unlinked bundle");
    const member = rule("member", "Member", "bundle");

    expect(await resolve([member], [bundle])).toEqual([]);
  });

  test("deduplicates Rules by ID across duplicate input paths", async () => {
    const direct = rule("shared", "Direct copy");
    const bundle = profile("bundle", "Bundle");
    const memberDuplicate = rule("shared", "Member copy", "bundle");

    const exported = await resolve([direct, memberDuplicate], [bundle], ["shared"], ["bundle"]);

    expect(exported.map((item) => item.id)).toEqual([direct.id]);
  });

  test("uses the deterministic manager order", async () => {
    const laterStandalone = rule("late", "Late standalone", null, { sortOrder: 30 });
    const secondMember = rule("second", "Zulu", "bundle", { sortOrder: 2 });
    const firstMember = rule("first", "Alpha", "bundle", { sortOrder: 2 });
    const bundle = profile("bundle", "Bundle", { sortOrder: 20 });
    const firstStandalone = rule("early", "Early standalone", null, { sortOrder: 10 });

    const exported = await resolve(
      [laterStandalone, secondMember, firstMember, firstStandalone],
      [bundle],
      ["late", "early"],
      ["bundle"],
    );

    expect(exported.map((item) => item.id)).toEqual([
      firstStandalone.id,
      firstMember.id,
      secondMember.id,
      laterStandalone.id,
    ]);
  });

  test("rejects when a required link lookup fails", async () => {
    const direct = rule("direct", "Direct");

    await expect(resolvePromptPresetExportRules({
      presetId: "preset-1",
      rules: [direct],
      profiles: [],
      getRuleLinks: async () => { throw new Error("offline"); },
      getProfileLinks: async () => [],
    })).rejects.toThrow("offline");
  });
});
