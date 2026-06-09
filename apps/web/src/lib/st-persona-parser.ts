/**
 * Parses SillyTavern persona data from settings.json.
 *
 * ST stores personas in `settings.json → power_user`:
 *   personas:            { [avatarFilename]: name }
 *   persona_descriptions: { [avatarFilename]: { description, position, role, depth, lorebook } }
 *   default_persona:     avatarFilename of the default persona
 *
 * Avatar PNGs live in `User Avatars/` next to settings.json.
 */

export interface StPersonaEntry {
  /** Avatar filename — also the key in ST's personas dict */
  key: string;
  /** Persona display name */
  name: string;
  /** Description / persona definition */
  description: string;
  /** Whether this is ST's default persona */
  isDefault: boolean;
  /** Relative path to avatar PNG (e.g. "User Avatars/key.png") */
  avatarRelativePath: string;
}

export function parseStPersonas(settingsJson: unknown): StPersonaEntry[] {
  const root = asRecord(settingsJson);
  if (!root) return [];
  const pu = asRecord(root.power_user);
  if (!pu) return [];

  const personasMap = asRecord(pu.personas);
  const descsMap = asRecord(pu.persona_descriptions);
  const defaultKey = typeof pu.default_persona === "string" ? pu.default_persona : "";

  if (!personasMap || Object.keys(personasMap).length === 0) return [];

  const entries: StPersonaEntry[] = [];

  for (const key of Object.keys(personasMap)) {
    const name = typeof personasMap[key] === "string" ? (personasMap[key] as string).trim() : "";
    if (!name) continue;

    const descObj = asRecord(descsMap?.[key]);
    const description = typeof descObj?.description === "string" ? descObj.description.trim() : "";

    entries.push({
      key,
      name,
      description,
      isDefault: key === defaultKey,
      avatarRelativePath: `User Avatars/${key}`,
    });
  }

  return entries;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
