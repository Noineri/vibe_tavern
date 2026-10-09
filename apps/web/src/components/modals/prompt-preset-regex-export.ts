import type { PromptPresetDto, RegexLink, RegexPreset, RegexProfile, RegexProfileLink } from "@vibe-tavern/domain";
import { serializeStPreset } from "@vibe-tavern/import-export";
import { buildFlatVisualOrder } from "../../lib/regex-profile-drop.js";
import { downloadTextFile } from "../../lib/download.js";

interface PromptPresetRegexExportInput {
  presetId: string;
  rules: RegexPreset[];
  profiles: RegexProfile[];
  getRuleLinks: (ruleId: string) => Promise<RegexLink[]>;
  getProfileLinks: (profileId: string) => Promise<RegexProfileLink[]>;
}

function linksToPreset(links: Array<{ targetType: string; targetId: string }>, presetId: string): boolean {
  return links.some((link) => link.targetType === "preset" && link.targetId === presetId);
}

/**
 * Resolves the Rules portable with one saved prompt preset.
 *
 * Member Rules inherit only their Profile's binding; their own dormant links
 * must not make them portable until they are detached. The returned sequence
 * is the Regex manager's shared visual order, not a second ordering policy.
 */
export async function resolvePromptPresetExportRules({
  presetId,
  rules,
  profiles,
  getRuleLinks,
  getProfileLinks,
}: PromptPresetRegexExportInput): Promise<RegexPreset[]> {
  const standaloneRules = rules.filter((rule) => rule.profileId === null && !rule.isGlobal);
  const linkedProfiles = profiles.filter((profile) => !profile.isGlobal);

  const [standaloneLinks, profileLinks] = await Promise.all([
    Promise.all(standaloneRules.map(async (rule) => [rule.id, await getRuleLinks(rule.id)] as const)),
    Promise.all(linkedProfiles.map(async (profile) => [profile.id, await getProfileLinks(profile.id)] as const)),
  ]);

  const directRuleIds = new Set<string>(
    standaloneLinks
      .filter(([, links]) => linksToPreset(links, presetId))
      .map(([id]) => id),
  );
  const linkedProfileIds = new Set<string>(
    profileLinks
      .filter(([, links]) => linksToPreset(links, presetId))
      .map(([id]) => id),
  );
  const rulesById = new Map<string, RegexPreset>(rules.map((rule) => [rule.id, rule]));
  const expandedProfileIds = new Set(profiles.map((profile) => profile.id));
  const exportedIds = new Set<string>();
  const exported: RegexPreset[] = [];

  for (const item of buildFlatVisualOrder(profiles, rules, expandedProfileIds)) {
    if (item.kind !== "rule") continue;
    const isDirectlyLinkedStandalone = item.profileId === null && directRuleIds.has(item.id);
    const isMemberOfLinkedProfile = item.profileId !== null && linkedProfileIds.has(item.profileId);
    if (!isDirectlyLinkedStandalone && !isMemberOfLinkedProfile) continue;
    if (exportedIds.has(item.id)) continue;
    const rule = rulesById.get(item.id);
    if (!rule) continue;
    exportedIds.add(item.id);
    exported.push(rule);
  }

  return exported;
}

interface ExportPromptPresetWithRegexInput extends Omit<PromptPresetRegexExportInput, "presetId"> {
  preset: PromptPresetDto;
}

/** Resolve portable Rules before serializing one saved prompt preset. */
export async function exportPromptPresetWithRegex({ preset, rules, profiles, getRuleLinks, getProfileLinks }: ExportPromptPresetWithRegexInput): Promise<void> {
  const exportRules = await resolvePromptPresetExportRules({
    presetId: preset.id,
    rules: [...rules],
    profiles: [...profiles],
    getRuleLinks,
    getProfileLinks,
  });
  const safeName = (preset.name || "preset").replace(/[^a-zA-Z0-9_-]/g, "_");
  downloadTextFile(`${safeName}.json`, serializeStPreset(preset, exportRules), "application/json");
}
