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
import type { CanvasLoreEntrySummary } from "../../../lib/prompt-canvas-lore.js";
import type { CanvasItem, CanvasRole, CharacterCanvasDraft, PromptCanvasDraft } from "./canvas-shared.js";
import { coerceRole } from "./canvas-shared.js";
import { LoreAnchorList, type LoreAnchorLoadState } from "./LoreAnchorList.js";
import { CanvasCard } from "./rows/CanvasCard.js";

/** Dependencies the fixed-items list closes over. Grouped into one object so
 *  the call site is a named spread rather than a 10-arg positional list. */
export interface FixedItemCtx {
  t: TFunc;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number | boolean) => void;
  characterDraft?: CharacterCanvasDraft | null;
  onCharacterFieldUpdate?: (key: keyof CharacterCanvasDraft, value: string | number) => void;
  personaDescription?: string | null;
  onPersonaDescriptionUpdate?: (value: string) => void;
  loreAnchorEntries?: CanvasLoreEntrySummary[];
  loreAnchorLoadState?: LoreAnchorLoadState;
  slotEnabled: (identifier: string) => boolean;
  togglePromptSlot: (identifier: string) => void;
  slotLabelFor: (identifier: string) => string | null;
  slotDepthFor: (identifier: string) => number | null;
  slotRoleFor: (identifier: string, fallback: CanvasRole) => CanvasRole;
  updateSlotDepth: (identifier: string, depth: number) => void;
  updateSlotRole: (identifier: string, role: CanvasRole) => void;
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
  const {
    t,
    draft,
    onUpdateField,
    characterDraft,
    onCharacterFieldUpdate,
    personaDescription,
    onPersonaDescriptionUpdate,
    loreAnchorEntries = [],
    loreAnchorLoadState = "idle",
  } = ctx;
  const disabled = !draft || !onUpdateField;
  const characterDisabled = !characterDraft || !onCharacterFieldUpdate;
  const personaDisabled = personaDescription == null || !onPersonaDescriptionUpdate;

  return [
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 0, render: () => (
      <CanvasCard identifier="main" category="standard" label={t("system_prompt")}
        {...toggleFor("main", ctx)} {...slotFor("main", ctx)}
        role={ctx.slotRoleFor("main", "system")} onRoleChange={(r) => ctx.updateSlotRole("main", r)}
        value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("system", v)} badge={t("editable_badge")} />
    ) },
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 10, render: () => (
      <CanvasCard identifier="worldInfoBefore" category="anchor" label={t("prompt_slot_world_info_before")}
        labelTooltip={t("prompt_slot_world_info_before_hint")} {...toggleFor("worldInfoBefore", ctx)}
        slotLabel={ctx.slotLabelFor("worldInfoBefore")} slotDepth={ctx.slotDepthFor("worldInfoBefore")}
        badge={t("cc_read_only")}
        expandedLeading={<LoreAnchorList entries={loreAnchorEntries} position="before_char" loadState={loreAnchorLoadState} />} />
    ) },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 20, render: () => (
      <CanvasCard identifier="personaDescription" category="persona" label={t("prompt_slot_persona")}
        {...toggleFor("personaDescription", ctx)} {...slotFor("personaDescription", ctx)}
        role={ctx.slotRoleFor("personaDescription", "system")} onRoleChange={(r) => ctx.updateSlotRole("personaDescription", r)}
        value={personaDescription ?? ""} placeholder={t("prompt_slot_persona_placeholder")}
        disabled={personaDisabled} onChange={(v) => onPersonaDescriptionUpdate?.(v)}
        badge={personaDescription == null ? t("cc_read_only") : t("persona_badge")} />
    ) },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 30, render: () => (
      <CanvasCard identifier="charDescription" category="character" label={t("prompt_slot_character_description")}
        {...toggleFor("charDescription", ctx)} {...slotFor("charDescription", ctx)}
        role={ctx.slotRoleFor("charDescription", "system")} onRoleChange={(r) => ctx.updateSlotRole("charDescription", r)}
        value={characterDraft?.charDescription ?? ""} placeholder={t("prompt_slot_character_description_placeholder")}
        disabled={characterDisabled} onChange={(v) => onCharacterFieldUpdate?.("charDescription", v)} badge={t("char_badge")} />
    ) },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 40, render: () => (
      <CanvasCard identifier="charPersonality" category="character" label={t("prompt_slot_character_personality")}
        {...toggleFor("charPersonality", ctx)} {...slotFor("charPersonality", ctx)}
        role={ctx.slotRoleFor("charPersonality", "system")} onRoleChange={(r) => ctx.updateSlotRole("charPersonality", r)}
        value={characterDraft?.charPersonality ?? ""} placeholder={t("prompt_slot_character_personality_placeholder")}
        disabled={characterDisabled} onChange={(v) => onCharacterFieldUpdate?.("charPersonality", v)} badge={t("char_badge")} />
    ) },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 50, render: () => (
      <CanvasCard identifier="scenario" category="character" label={t("scenario")}
        {...toggleFor("scenario", ctx)} {...slotFor("scenario", ctx)}
        role={ctx.slotRoleFor("scenario", "system")} onRoleChange={(r) => ctx.updateSlotRole("scenario", r)}
        value={characterDraft?.scenario ?? ""} placeholder={t("prompt_slot_scenario_placeholder")}
        disabled={characterDisabled} onChange={(v) => onCharacterFieldUpdate?.("scenario", v)} badge={t("char_badge")} />
    ) },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => (
      <CanvasCard identifier="authorsNote" category="standard" label={t("authors_note_label")}
        {...toggleFor("authorsNote", ctx)} {...slotFor("authorsNote", ctx)}
        role={ctx.slotRoleFor("authorsNote", coerceRole(draft?.authorsNoteRole))} onRoleChange={(r) => ctx.updateSlotRole("authorsNote", r)}
        value={draft?.authorsNote ?? ""} placeholder={t("authors_note_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("authorsNote", v)} badge={t("editable_badge")} />
    ) },
    { key: "field:enhanceDefinitions", identifier: "enhanceDefinitions", kind: "field", defaultOrder: 70, render: () => (
      <CanvasCard identifier="enhanceDefinitions" category="standard" label={t("enhance_definitions")}
        {...toggleFor("enhanceDefinitions", ctx)} {...slotFor("enhanceDefinitions", ctx)}
        role={ctx.slotRoleFor("enhanceDefinitions", "system")} onRoleChange={(r) => ctx.updateSlotRole("enhanceDefinitions", r)}
        value={draft?.enhanceDefinitions ?? ""} placeholder={t("enhance_definitions_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("enhanceDefinitions", v)} badge={t("editable_badge")} />
    ) },
    { key: "field:nsfw", identifier: "nsfw", kind: "field", defaultOrder: 75, render: () => (
      <CanvasCard identifier="nsfw" category="standard" label={t("nsfw_prompt")}
        {...toggleFor("nsfw", ctx)} {...slotFor("nsfw", ctx)}
        role={ctx.slotRoleFor("nsfw", "system")} onRoleChange={(r) => ctx.updateSlotRole("nsfw", r)}
        value={draft?.nsfw ?? ""} placeholder={t("nsfw_prompt_placeholder")}
        disabled={disabled} onChange={(v) => onUpdateField?.("nsfw", v)} badge={t("editable_badge")} />
    ) },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 80, render: () => (
      <CanvasCard identifier="worldInfoAfter" category="anchor" label={t("prompt_slot_world_info_after")}
        labelTooltip={t("prompt_slot_world_info_after_hint")} {...toggleFor("worldInfoAfter", ctx)}
        slotLabel={ctx.slotLabelFor("worldInfoAfter")} slotDepth={ctx.slotDepthFor("worldInfoAfter")}
        badge={t("cc_read_only")}
        expandedLeading={<LoreAnchorList entries={loreAnchorEntries} position="after_char" loadState={loreAnchorLoadState} />} />
    ) },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 90, render: () => (
      <CanvasCard identifier="dialogueExamples" category="character" label={t("prompt_slot_dialogue_examples")}
        {...toggleFor("dialogueExamples", ctx)} {...slotFor("dialogueExamples", ctx)}
        role={ctx.slotRoleFor("dialogueExamples", "system")} onRoleChange={(r) => ctx.updateSlotRole("dialogueExamples", r)}
        value={characterDraft?.dialogueExamples ?? ""} placeholder={t("dialog_examples_placeholder")}
        disabled={characterDisabled} onChange={(v) => onCharacterFieldUpdate?.("dialogueExamples", v)} badge={t("char_badge")} />
    ) },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 110, render: () => (
      <CanvasCard identifier="jailbreak" category="standard" label={t("post_history_instructions")}
        {...toggleFor("jailbreak", ctx)} {...slotFor("jailbreak", ctx)}
        role={ctx.slotRoleFor("jailbreak", "system")} onRoleChange={(r) => ctx.updateSlotRole("jailbreak", r)}
        value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")}
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
        role={ctx.slotRoleFor("charSystemPrompt", "system")} onRoleChange={(r) => ctx.updateSlotRole("charSystemPrompt", r)}
        value={characterDraft.charSystemPrompt}
        onChange={(v) => onCharacterFieldUpdate?.("charSystemPrompt", v)} badge={t("char_badge")} />
    ) }] : []),
    ...(characterDraft ? [{ key: "char:postHistory", identifier: "charPostHistory", kind: "field" as const, defaultOrder: 115, render: () => (
      <CanvasCard identifier="charPostHistory" category="character" label={t("character_post_history")}
        {...toggleFor("charPostHistory", ctx)} {...slotFor("charPostHistory", ctx)}
        role={ctx.slotRoleFor("charPostHistory", "system")} onRoleChange={(r) => ctx.updateSlotRole("charPostHistory", r)}
        value={characterDraft.charPostHistory}
        onChange={(v) => onCharacterFieldUpdate?.("charPostHistory", v)} badge={t("char_badge")} />
    ) }] : []),
    ...(characterDraft ? [{ key: "char:depthPrompt", identifier: "charDepthPrompt", kind: "field" as const, defaultOrder: 65, render: () => (
      <CanvasCard identifier="charDepthPrompt" category="character" label={t("character_depth_prompt")}
        {...toggleFor("charDepthPrompt", ctx)} {...slotFor("charDepthPrompt", ctx)} depthMin={1}
        role={ctx.slotRoleFor("charDepthPrompt", coerceRole(characterDraft.charDepthPromptRole))} onRoleChange={(r) => ctx.updateSlotRole("charDepthPrompt", r)}
        value={characterDraft.charDepthPrompt} onChange={(v) => onCharacterFieldUpdate?.("charDepthPrompt", v)} badge={t("char_badge")} />
    ) }] : []),
  ];
}
