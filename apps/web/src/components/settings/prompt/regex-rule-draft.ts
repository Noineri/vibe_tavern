import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { parseFindRegex } from "@vibe-tavern/prompt-pipeline";
import { applyTargetFlags, regexApplyTargetOf, REGEX_PLACEMENT } from "@vibe-tavern/domain";
import { createRegexPreset } from "../../../api/regex-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import type { RegexPresetRecord } from "../../../api/types.js";
import type { RegexPlacement, RegexSubstituteMode, RegexApplyTarget } from "@vibe-tavern/domain";

/**
 * RXU-14 (REGEX_RULE_PROFILE_UX_PORTABILITY_PLAN, Wave 1): the manual
 * Rule-draft domain. Manual creation opens an EMPTY UNSAVED local draft —
 * no placeholder regex is persisted to reserve a list row (owner correction:
 * "why not just empty?" — quoted verbatim in the plan) — and the first valid Save performs exactly
 * ONE create, born directly inside its intended Profile via the RXU-13
 * client `profileId` field (never create-then-attach).
 *
 * Extracted from RegexPresetEditor.tsx / PromptManagerModal.tsx so neither
 * component file grows past its arch-gate ceiling. Owns: the editor-agnostic
 * draft shape, the pure Save gate, the one-write create payload, and the
 * open→edit→save→discard lifecycle hook.
 */

/** The editable form state of one regex rule (editor-agnostic — the editor
 *  renders it, this module owns its shape and lifecycle). */
export interface RegexPresetDraft {
  name: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string;
  substituteRegex: RegexSubstituteMode;
  placement: RegexPlacement[];
  minDepth: string;
  maxDepth: string;
  isGlobal: boolean;
  disabled: boolean;
  applyTarget: RegexApplyTarget;
}

export function regexDraftFromRecord(p: RegexPresetRecord): RegexPresetDraft {
  return {
    name: p.name,
    findRegex: p.findRegex,
    replaceString: p.replaceString,
    trimStrings: p.trimStrings.join("\n"),
    substituteRegex: p.substituteRegex as RegexSubstituteMode,
    placement: [...p.placement] as RegexPlacement[],
    minDepth: p.minDepth === null ? "" : String(p.minDepth),
    maxDepth: p.maxDepth === null ? "" : String(p.maxDepth),
    isGlobal: p.isGlobal,
    disabled: p.disabled,
    applyTarget: regexApplyTargetOf(p),
  };
}

export function emptyRegexDraft(): RegexPresetDraft {
  return {
    name: "",
    findRegex: "",
    replaceString: "",
    trimStrings: "",
    substituteRegex: 0,
    placement: [REGEX_PLACEMENT.AiOutput],
    minDepth: "",
    maxDepth: "",
    isGlobal: false,
    disabled: false,
    applyTarget: "persist",
  };
}

/** Which required field still blocks the first Save of a NEW rule draft;
 *  null = savable. Mirrors the live-test pane's validity idiom
 *  (`parseFindRegex` never throws — an empty or broken pattern is caught by
 *  compiling). ONE derivation shared by the editor's field feedback and the
 *  Save-button gate. */
export type RegexDraftSaveIssue = { field: "name" } | { field: "findRegex" };

export function regexDraftSaveIssue(draft: RegexPresetDraft): RegexDraftSaveIssue | null {
  if (draft.name.trim() === "") return { field: "name" };
  // An empty pattern parses ("" compiles) but is not a Regex — the server
  // contract (createRegexPresetSchema) requires min 1.
  if (draft.findRegex.trim() === "") return { field: "findRegex" };
  const parsed = parseFindRegex(draft.findRegex);
  try {
    new RegExp(parsed.pattern, parsed.flags);
    return null;
  } catch {
    return { field: "findRegex" };
  }
}

/** The ONE create payload for a new rule's first Save — the draft's fields
 *  as typed, the agreed disabled default, and the intended Profile
 *  membership via the client `profileId` field (RXU-13). */
export function createRegexPresetFromDraft(
  draft: RegexPresetDraft,
  profileId: string | null,
): Promise<RegexPresetRecord> {
  const flags = applyTargetFlags(draft.applyTarget);
  const trimStrings = draft.trimStrings.split("\n").filter((s) => s.length > 0);
  const minDepth = draft.minDepth === "" ? null : Number(draft.minDepth);
  const maxDepth = draft.maxDepth === "" ? null : Number(draft.maxDepth);
  return createRegexPreset({
    name: draft.name,
    findRegex: draft.findRegex,
    replaceString: draft.replaceString,
    trimStrings,
    substituteRegex: draft.substituteRegex,
    // Agreed manual default: born disabled unless the user turned Active on.
    disabled: draft.disabled,
    isGlobal: draft.isGlobal,
    placement: draft.placement,
    minDepth: Number.isNaN(minDepth) ? null : minDepth,
    maxDepth: Number.isNaN(maxDepth) ? null : maxDepth,
    markdownOnly: flags.markdownOnly,
    promptOnly: flags.promptOnly,
    ...(profileId ? { profileId } : {}),
  });
}

/** Host state the draft lifecycle orchestrates — generic React setters, so
 *  the hook stays decoupled from any one parent component. */
export interface RegexRuleDraftHost {
  /** Host open flag — closing the host discards an unsaved draft. */
  isOpen: boolean;
  setRegexDraft: (draft: RegexPresetDraft) => void;
  setRegexDirty: (dirty: boolean) => void;
  setRegexSaveState: (state: "idle" | "saving" | "saved" | "error") => void;
  setActiveRegexPresetId: (id: string | null) => void;
  setActiveRegexProfileId: (id: string | null) => void;
  setRegexPresets: Dispatch<SetStateAction<RegexPresetRecord[]>>;
  setExpandedProfileIds: Dispatch<SetStateAction<Set<string>>>;
}

export interface RegexRuleDraftController {
  /** The open draft and its intended Profile (null = standalone);
   *  null = no draft open. */
  draft: { profileId: string | null } | null;
  /** Open an empty unsaved draft. Zero server writes; no list row exists. */
  open: (name: string, profileId: string | null) => void;
  /** Discard the draft — zero server writes, no list mutation. */
  discard: () => void;
  /** First valid Save: exactly ONE create, born directly in the Profile. */
  save: (draft: RegexPresetDraft) => void;
  /** Save-button gate: true while name or Regex is missing/invalid. */
  saveBlocked: (draft: RegexPresetDraft) => boolean;
}

/** Lifecycle of a manually created Rule: open → edit locally → ONE create on
 *  first valid Save → discard on selection change or host close. */
export function useRegexRuleDraft(host: RegexRuleDraftHost): RegexRuleDraftController {
  const [draft, setDraft] = useState<{ profileId: string | null } | null>(null);

  // Closing the host discards an unsaved draft — nothing was ever sent to
  // the server, so there is nothing to compensate, only local state.
  useEffect(() => {
    if (!host.isOpen) setDraft(null);
  }, [host.isOpen]);

  const open = (name: string, profileId: string | null) => {
    setDraft({ profileId });
    host.setActiveRegexPresetId(null);
    host.setActiveRegexProfileId(null);
    // Find/replace start EMPTY and Active starts OFF — the agreed manual
    // default is disabled on first persistence (toggling Active before the
    // first Save opts in by editing the draft).
    host.setRegexDraft({ ...emptyRegexDraft(), name, disabled: true });
    host.setRegexDirty(false);
    host.setRegexSaveState("idle");
    if (profileId !== null) host.setExpandedProfileIds((prev) => new Set([...prev, profileId]));
  };

  const discard = () => setDraft(null);

  const save = (fields: RegexPresetDraft) => {
    // Belt to the disabled Save button's braces: an invalid draft never writes.
    if (!draft || regexDraftSaveIssue(fields)) return;
    host.setRegexSaveState("saving");
    void createRegexPresetFromDraft(fields, draft.profileId)
      .then((created) => {
        setDraft(null);
        host.setRegexPresets((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
        host.setActiveRegexPresetId(created.id);
        host.setActiveRegexProfileId(null);
        host.setRegexDirty(false);
        host.setRegexSaveState("saved");
        invalidateActiveRegexPresets();
        setTimeout(() => host.setRegexSaveState("idle"), 2200);
      })
      .catch(() => host.setRegexSaveState("error"));
  };

  const saveBlocked = (fields: RegexPresetDraft) => regexDraftSaveIssue(fields) !== null;

  return { draft, open, discard, save, saveBlocked };
}
