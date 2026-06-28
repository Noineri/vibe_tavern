/**
 * Parses SillyTavern persona data from either of two accepted JSON shapes:
 *
 * 1. ST settings.json (the live-ST data shape) — personas nested under
 *    `power_user`:
 *      power_user.personas:             { [avatarFilename]: name }
 *      power_user.persona_descriptions: { [avatarFilename]: { description, ... } }
 *      power_user.default_persona:      avatarFilename of the default persona
 *
 * 2. ST backup / VT-export shape — personas at the TOP level (NOT nested in
 *    power_user). This is the shape VT's own `exportPersona("st")` emits
 *    (services/api persona-export.ts mergeStSlices) and the shape a real ST
 *    backup file stores. Accepting it lets a user round-trip a file VT itself
 *    exported, and import an ST backup directly without unpacking settings.json.
 *      personas:             { [avatarFilename]: name }
 *      persona_descriptions: { [avatarFilename]: { description, ... } }
 *      default_persona:      avatarFilename of the default persona
 *
 * When BOTH a top-level `personas` and a `power_user.personas` are present,
 * the top-level (backup) shape wins — it is the more specific intent.
 *
 * Avatar PNGs are not parsed here; they are resolved by the caller from
 * `User Avatars/<key>` when importing from a folder. File-only imports have no
 * avatars (the caller handles the missing-avatar case).
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

  // Prefer the top-level backup/export shape (more specific intent); fall back
  // to the settings.json shape nested under power_user.
  const topLevelPersonas = asRecord(root.personas);
  const useTopLevel = topLevelPersonas && Object.keys(topLevelPersonas).length > 0;

  let personasMap: Record<string, unknown> | null;
  let descsMap: Record<string, unknown> | null;
  let defaultKey: string;
  if (useTopLevel) {
    personasMap = topLevelPersonas;
    descsMap = asRecord(root.persona_descriptions);
    defaultKey = typeof root.default_persona === "string" ? root.default_persona : "";
  } else {
    const pu = asRecord(root.power_user);
    if (!pu) return [];
    personasMap = asRecord(pu.personas);
    descsMap = asRecord(pu.persona_descriptions);
    defaultKey = typeof pu.default_persona === "string" ? pu.default_persona : "";
  }

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
