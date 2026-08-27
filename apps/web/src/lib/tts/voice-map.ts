import type { TtsLinkRecord } from "../../api/tts-api.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";

export type NarrationVoiceResolution =
  | { kind: "profile"; profile: TtsProfileRecord }
  | { kind: "disabled" }
  | { kind: "none" };

export interface NarrationVoiceTargets {
  characterId?: string;
  personaId?: string;
}

/** Voice-map resolution (TTS_PLAN TS-9a). Order is LOCKED by the plan:
 *  1. DISABLED: any link with mode "disabled" targeting the character OR the
 *     persona ⇒ { kind: "disabled" } — the target is excluded from narration
 *     regardless of profile (disable wins over every voice binding).
 *  2. CHARACTER override: links with mode "voice" targeting characterId ⇒
 *     the bound profile. Multiple bound profiles ⇒ deterministic pick:
 *     isDefault profile first, then lowest sortOrder, then name ASC.
 *  3. PERSONA override: same for personaId.
 *  4. DEFAULT: the profile with isDefault === true.
 *  5. Else { kind: "none" }.
 *  A link whose profileId is not present in `profiles` is treated as no
 *  binding (stale link after a profile delete — the FK normally prevents
 *  this, but the client list may race). Pure function, no I/O. */
export function resolveNarrationProfile(
  profiles: TtsProfileRecord[],
  links: TtsLinkRecord[],
  targets: NarrationVoiceTargets,
): NarrationVoiceResolution {
  const normalizeMode = (mode: string | undefined): "voice" | "disabled" =>
    mode === "disabled" ? "disabled" : "voice";

  // 1. Disabled wins
  if (targets.characterId !== undefined) {
    const disabled = links.some(
      (l) => l.targetId === targets.characterId && l.targetType === "character" && normalizeMode(l.mode) === "disabled",
    );
    if (disabled) return { kind: "disabled" };
  }
  if (targets.personaId !== undefined) {
    const disabled = links.some(
      (l) => l.targetId === targets.personaId && l.targetType === "persona" && normalizeMode(l.mode) === "disabled",
    );
    if (disabled) return { kind: "disabled" };
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const pickFromLinks = (targetId: string, targetType: string): TtsProfileRecord | null => {
    const candidates: TtsProfileRecord[] = [];
    for (const link of links) {
      if (link.targetId !== targetId) continue;
      if (link.targetType !== targetType) continue;
      if (normalizeMode(link.mode) !== "voice") continue;
      const profile = profileById.get(link.ttsProfileId);
      if (!profile) continue;
      candidates.push(profile);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    });
    return candidates[0] ?? null;
  };

  // 2. Character override
  if (targets.characterId !== undefined) {
    const picked = pickFromLinks(targets.characterId, "character");
    if (picked) return { kind: "profile", profile: picked };
  }

  // 3. Persona override
  if (targets.personaId !== undefined) {
    const picked = pickFromLinks(targets.personaId, "persona");
    if (picked) return { kind: "profile", profile: picked };
  }

  // 4. Default
  const defaults = profiles.filter((p) => p.isDefault);
  if (defaults.length > 0) {
    defaults.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    });
    const def = defaults[0];
    if (def) return { kind: "profile", profile: def };
  }

  // 5. None
  return { kind: "none" };
}
