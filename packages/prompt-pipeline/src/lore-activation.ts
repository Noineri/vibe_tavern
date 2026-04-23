import type { PromptLayerPosition } from "./types.js";

export type LoreActivationLogic = "and_any" | "and_all" | "not_any" | "not_all";

export interface ActivatableLoreEntry {
  id: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: LoreActivationLogic;
  position?: PromptLayerPosition;
  priority: number;
  enabled: boolean;
}

export interface LoreActivationContext {
  recentMessagesText: string;
  personaText?: string | null;
  characterText?: string | null;
  scenarioText?: string | null;
}

export interface ActivatedLoreEntry extends ActivatableLoreEntry {
  matchedPrimaryKeys: string[];
  matchedSecondaryKeys: string[];
  activationReason: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function isRegexKey(key: string): boolean {
  return key.startsWith("/") && key.lastIndexOf("/") > 0;
}

function testRegexKey(key: string, text: string): boolean {
  const lastSlash = key.lastIndexOf("/");
  const pattern = key.slice(1, lastSlash);
  const flags = key.slice(lastSlash + 1);

  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(text);
  } catch {
    return false;
  }
}

function testPlainKey(key: string, text: string): boolean {
  return normalizeText(text).includes(normalizeText(key));
}

function keyMatches(key: string, text: string): boolean {
  return isRegexKey(key) ? testRegexKey(key, text) : testPlainKey(key, text);
}

function collectMatches(keys: string[], text: string): string[] {
  return keys.filter((key) => key.trim().length > 0 && keyMatches(key.trim(), text));
}

function passesSecondaryLogic(
  logic: LoreActivationLogic,
  matchedSecondaryKeys: string[],
  totalSecondaryKeys: number,
): boolean {
  if (totalSecondaryKeys === 0) {
    return true;
  }

  switch (logic) {
    case "and_any":
      return matchedSecondaryKeys.length > 0;
    case "and_all":
      return matchedSecondaryKeys.length === totalSecondaryKeys;
    case "not_any":
      return matchedSecondaryKeys.length === 0;
    case "not_all":
      return matchedSecondaryKeys.length < totalSecondaryKeys;
    default:
      return true;
  }
}

export function activateLoreEntries(
  entries: ActivatableLoreEntry[],
  context: LoreActivationContext,
): ActivatedLoreEntry[] {
  const scanText = [
    context.recentMessagesText,
    context.personaText ?? "",
    context.characterText ?? "",
    context.scenarioText ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const activated: ActivatedLoreEntry[] = [];

  for (const entry of entries) {
    if (!entry.enabled || !entry.content.trim()) {
      continue;
    }

    const matchedPrimaryKeys = collectMatches(entry.keys, scanText);
    if (entry.keys.length > 0 && matchedPrimaryKeys.length === 0) {
      continue;
    }

    const matchedSecondaryKeys = collectMatches(entry.secondaryKeys, scanText);
    if (!passesSecondaryLogic(entry.logic, matchedSecondaryKeys, entry.secondaryKeys.length)) {
      continue;
    }

    activated.push({
      ...entry,
      matchedPrimaryKeys,
      matchedSecondaryKeys,
      activationReason: `primary=${matchedPrimaryKeys.length}, secondary=${matchedSecondaryKeys.length}, logic=${entry.logic}`,
    });
  }

  return activated.sort((a, b) => b.priority - a.priority);
}
