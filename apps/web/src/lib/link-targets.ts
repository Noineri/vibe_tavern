/**
 * link-targets — the ONE place records become `LinkTarget`s
 * (AGENTS.md §3 «one data source, many consumers»).
 *
 * Every surface that offers link bindings (BoundResourcesField,
 * AiAssistantModal, TtsBindingFields, RegexPresetEditor, RegexProfileEditor,
 * CoauthorCharacterForm, DiceAssignment, LorebookEditor, ScriptEditor) reads
 * its targets through these mappers and only renders the result — a second
 * hand-written record→LinkTarget derivation anywhere is a defect from
 * copy #2. The mappers are pure: no store access, no I/O. The wire-level
 * link record + target-type union live here too (moved from
 * LinkBindingPopover in LB-2B so lib/link-binding-sections.ts — the section
 * derivation — never imports from components/).
 *
 * Every target carries `updatedAt` (the `?v=` avatar cache-bust and the
 * Wave-2 «recently updated» ordering both depend on it).
 */
import type {
	AppCharacterEntry,
	LorebookRecord,
	PersonaRecord,
	RegexPresetRecord,
	ScriptRecord,
} from "../api/types.js";

export interface LinkTarget {
  id: string;
  name: string;
  avatarAssetId: string | null;
  /**
   * Entity kind for folder-resident avatar resolution
   * (resolveEntityAvatarUrl). Omitted for targets without a folder avatar
   * (e.g. lorebooks) — falls back to legacy flat-asset URL.
   */
  kind?: "characters" | "personas";
  avatarExt?: string | null;
  avatarFullExt?: string | null;
  avatarFullAssetId?: string | null;
  updatedAt?: string | null;
}

export type LinkBindingTargetType = "character" | "persona" | "lorebook" | "script" | "preset" | "regex";

export interface LinkBindingRecord {
  targetType: LinkBindingTargetType;
  targetId: string;
}

/** Character fields the mapper reads — structural, so any caller's
 *  character-shaped data (e.g. `useAllCharacters()` entries) fits without
 *  casts. */
export type CharacterLinkSource = Pick<
	AppCharacterEntry,
	"id" | "name" | "avatarAssetId" | "avatarFullAssetId" | "avatarExt" | "avatarFullExt" | "updatedAt"
>;

/** Persona twin of {@link CharacterLinkSource}. */
export type PersonaLinkSource = Pick<
	PersonaRecord,
	"id" | "name" | "avatarAssetId" | "avatarFullAssetId" | "avatarExt" | "avatarFullExt" | "updatedAt"
>;

/** Lorebook fields the mapper reads (lorebooks have no avatar). */
export type LorebookLinkSource = Pick<LorebookRecord, "id" | "name" | "updatedAt">;

/** Script fields the mapper reads (scripts have no avatar). */
export type ScriptLinkSource = Pick<ScriptRecord, "id" | "name" | "updatedAt">;

/** Regex-preset fields the mapper reads (regex presets have no avatar). */
export type RegexLinkSource = Pick<RegexPresetRecord, "id" | "name" | "updatedAt">;

/** Map a character record to its LinkTarget (canonical avatar-field set —
 *  the shape TtsBindingFields/LorebookEditor build today). */
export function characterToLinkTarget(c: CharacterLinkSource): LinkTarget {
  return {
    id: c.id,
    name: c.name,
    avatarAssetId: c.avatarAssetId,
    kind: "characters",
    avatarExt: c.avatarExt,
    avatarFullExt: c.avatarFullExt,
    avatarFullAssetId: c.avatarFullAssetId,
    updatedAt: c.updatedAt,
  };
}

/** Map a persona record to its LinkTarget. `avatarFullAssetId` is part of
 *  the canonical set (a caller that omits it silently breaks full-slot
 *  resolution for legacy flat-avatar personas). */
export function personaToLinkTarget(p: PersonaLinkSource): LinkTarget {
  return {
    id: p.id,
    name: p.name,
    avatarAssetId: p.avatarAssetId,
    kind: "personas",
    avatarExt: p.avatarExt,
    avatarFullExt: p.avatarFullExt,
    avatarFullAssetId: p.avatarFullAssetId,
    updatedAt: p.updatedAt,
  };
}

/** Map a lorebook record. No avatar → the popover's name-initial dot. */
export function lorebookToLinkTarget(lb: LorebookLinkSource): LinkTarget {
  return { id: lb.id, name: lb.name, avatarAssetId: null, updatedAt: lb.updatedAt };
}

/** Map a script record. No avatar → the name-initial dot (same as lorebooks). */
export function scriptToLinkTarget(sc: ScriptLinkSource): LinkTarget {
  return { id: sc.id, name: sc.name, avatarAssetId: null, updatedAt: sc.updatedAt };
}

/** Map a regex preset record. No avatar → the name-initial dot. */
export function regexToLinkTarget(rx: RegexLinkSource): LinkTarget {
  return { id: rx.id, name: rx.name, avatarAssetId: null, updatedAt: rx.updatedAt };
}
