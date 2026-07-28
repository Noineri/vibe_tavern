/**
 * Builds the fixed (built-in) `CanvasItem[]` for the prompt-order canvas: the
 * system / jailbreak / prefill / author-note / nsfw / enhance editable fields,
 * the lorebook + persona + dialogue markers, and (when present) the three
 * character-V3 override fields. Extracted out of `InjectionTable.tsx`
 * (CANVAS_SINGLE_SOURCE_PLAN Wave 5 / god-object audit step 5) so the canvas
 * body is just DnD + layout and the full ordered slot list is scannable in one
 * place, separate from the component that renders/drags it.
 *
 * APC-4b: the per-type field cards (EditablePromptCard / EditableAuthorNoteCard
 * / CharacterFieldCard) were folded into the unified `CanvasCard` template —
 * every editable field now renders through it. The two local bundlers
 * (`toggleFor`, `slotFor`) collapse the `enabled`/`onToggle` and
 * `slotLabel`/`slotDepth`/`onSlotDepthChange` wiring that every card repeats
 * per-identifier.
 */
import type { TFunc } from "../../../i18n/context.js";
import type { CanvasItem, CharacterCanvasDraft, PromptCanvasDraft } from "./canvas-shared.js";
import { coerceRole } from "./canvas-shared.js";
import { CanvasCard } from "./rows/CanvasCard.js";
import { PromptOrderMarker } from "./rows/PromptOrderMarker.js";

/** Dependencies the fixed-items list closes over. Grouped into one object so
 *  the call site is a named spread rather than a 10-arg positional list. */
export interface FixedItemCtx {
  t: TFunc;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
  characterDraft?: CharacterCanvasDraft | null;
  onCharacterFieldUpdate?: (key: keyof CharacterCanvasDraft, value: string | number) => void;
  slotEnabled: (identifier: string) => boolean;
  togglePromptSlot: (identifier: string) => void;
  slotLabelFor: (identifier: string) => string | null;
  slotDepthFor: (identifier: string) => number | null;
  updateSlotDepth: (identifier: string, depth: number) => void;
}

/** Per-identifier `enabled` + bound `onToggle` — `CanvasCard.onToggle` is
 *  `() => void`, so bind the identifier here rather than at the call site. */
function toggleFor(id: string, ctx: FixedItemCtx) {
  return { enabled: ctx.slotEnabled(id), onToggle: () => ctx.togglePromptSlot(id) };
}

/** Per-identifier slot-position props — label + depth + depth-change. */
function slotFor(id: string, ctx: FixedItemCtx) {
  return {
    slotLabel: ctx.slotLabelFor(id),
    slotDepth: ctx.slotDepthFor(id),
    onSlotDepthChange: (d: number) => ctx.updateSlotDepth(id, d),
  };
}

export function buildFixedItems(ctx: FixedItemCtx): CanvasItem[] {
  const { t, draft, onUpdateField, characterDraft, onCharacterFieldUpdate } = ctx;
  const disabled = !draft || !onUpdateField;

  return [
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 0, render: () => (
      <CanvasCard identifier="main" category="standard" label={t("system_prompt")}
        {...toggleFor("main", ctx)} {...slotFor("main", ctx)}
        role="system" value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("system", v)} badge={t("editable_badge")} />
    ) },
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 10, render: () => (
      <PromptOrderMarker identifier="worldInfoBefore" label={t("prompt_slot_world_info_before")} tooltip={t("prompt_slot_world_info_before_hint")} kind="marker" {...toggleFor("worldInfoBefore", ctx)} />
    ) },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 20, render: () => (
      <PromptOrderMarker identifier="personaDescription" label={t("prompt_slot_persona")} kind="builtIn" {...toggleFor("personaDescription", ctx)} />
    ) },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 30, render: () => (
      <PromptOrderMarker identifier="charDescription" label={t("prompt_slot_character_description")} kind="builtIn" {...toggleFor("charDescription", ctx)} />
    ) },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 40, render: () => (
      <PromptOrderMarker identifier="charPersonality" label={t("prompt_slot_character_personality")} kind="builtIn" {...toggleFor("charPersonality", ctx)} />
    ) },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 50, render: () => (
      <PromptOrderMarker identifier="scenario" label={t("scenario")} kind="builtIn" {...toggleFor("scenario", ctx)} />
    ) },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => (
      <CanvasCard identifier="authorsNote" category="standard" label={t("authors_note_label")}
        {...toggleFor("authorsNote", ctx)} {...slotFor("authorsNote", ctx)}
        role={coerceRole(draft?.authorsNoteRole)} onRoleChange={(r) => onUpdateField?.("authorsNoteRole", r)}
        value={draft?.authorsNote ?? ""} placeholder={t("authors_note_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("authorsNote", v)} badge={t("editable_badge")} />
    ) },
    { key: "field:enhanceDefinitions", identifier: "enhanceDefinitions", kind: "field", defaultOrder: 70, render: () => (
      <CanvasCard identifier="enhanceDefinitions" category="standard" label={t("enhance_definitions")}
        {...toggleFor("enhanceDefinitions", ctx)} {...slotFor("enhanceDefinitions", ctx)}
        role="system" value={draft?.enhanceDefinitions ?? ""} placeholder={t("enhance_definitions_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("enhanceDefinitions", v)} badge={t("editable_badge")} />
    ) },
    { key: "field:nsfw", identifier: "nsfw", kind: "field", defaultOrder: 75, render: () => (
      <CanvasCard identifier="nsfw" category="standard" label={t("nsfw_prompt")}
        {...toggleFor("nsfw", ctx)} {...slotFor("nsfw", ctx)}
        role="system" value={draft?.nsfw ?? ""} placeholder={t("nsfw_prompt_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("nsfw", v)} badge={t("editable_badge")} />
    ) },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 80, render: () => (
      <PromptOrderMarker identifier="worldInfoAfter" label={t("prompt_slot_world_info_after")} tooltip={t("prompt_slot_world_info_after_hint")} kind="marker" {...toggleFor("worldInfoAfter", ctx)} />
    ) },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 90, render: () => (
      <PromptOrderMarker identifier="dialogueExamples" label={t("prompt_slot_dialogue_examples")} kind="marker" {...toggleFor("dialogueExamples", ctx)} />
    ) },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 110, render: () => (
      <CanvasCard identifier="jailbreak" category="standard" label={t("post_history_instructions")}
        {...toggleFor("jailbreak", ctx)} {...slotFor("jailbreak", ctx)}
        role="system" value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("jailbreak", v)} badge={t("editable_badge")} />
    ) },
    { key: "field:assistantPrefill", identifier: "assistantPrefill", kind: "field", defaultOrder: 999, render: () => (
      <CanvasCard identifier="assistantPrefill" category="standard" label={t("prefill_assistant")}
        {...toggleFor("assistantPrefill", ctx)}
        role="assistant" value={draft?.prefill ?? ""} placeholder={t("prefill_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("prefill", v)} draggable={false} badge={t("editable_badge")} />
    ) },

    // Character V3 overrides — only shown when the character has these fields
    ...(characterDraft ? [{ key: "char:systemPrompt", identifier: "charSystemPrompt", kind: "field" as const, defaultOrder: 1, render: () => (
      <CanvasCard identifier="charSystemPrompt" category="character" label={t("character_system_prompt")}
        {...toggleFor("charSystemPrompt", ctx)} {...slotFor("charSystemPrompt", ctx)}
        role="system" value={characterDraft.charSystemPrompt}
        onChange={(v) => onCharacterFieldUpdate?.("charSystemPrompt", v)} badge={t("char_badge")} />
    ) }] : []),
    ...(characterDraft ? [{ key: "char:postHistory", identifier: "charPostHistory", kind: "field" as const, defaultOrder: 115, render: () => (
      <CanvasCard identifier="charPostHistory" category="character" label={t("character_post_history")}
        {...toggleFor("charPostHistory", ctx)} {...slotFor("charPostHistory", ctx)}
        role="system" value={characterDraft.charPostHistory}
        onChange={(v) => onCharacterFieldUpdate?.("charPostHistory", v)} badge={t("char_badge")} />
    ) }] : []),
    ...(characterDraft ? [{ key: "char:depthPrompt", identifier: "charDepthPrompt", kind: "field" as const, defaultOrder: 65, render: () => (
      <CanvasCard identifier="charDepthPrompt" category="character" label={t("character_depth_prompt")}
        {...toggleFor("charDepthPrompt", ctx)} {...slotFor("charDepthPrompt", ctx)} depthMin={1}
        role={coerceRole(characterDraft.charDepthPromptRole)} onRoleChange={(r) => onCharacterFieldUpdate?.("charDepthPromptRole", r)}
        value={characterDraft.charDepthPrompt} onChange={(v) => onCharacterFieldUpdate?.("charDepthPrompt", v)} badge={t("char_badge")} />
    ) }] : []),
  ];
}
