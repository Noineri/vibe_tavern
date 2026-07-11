/**
 * Builds the fixed (built-in) `CanvasItem[]` for the prompt-order canvas: the
 * system / jailbreak / prefill / author-note / nsfw / enhance editable fields,
 * the lorebook + persona + dialogue markers, and (when present) the three
 * character-V3 override fields. Extracted out of `InjectionTable.tsx`
 * (CANVAS_SINGLE_SOURCE_PLAN Wave 5 / god-object audit step 5) so the canvas
 * body is just DnD + layout and the full ordered slot list is scannable in one
 * place, separate from the component that renders/drags it.
 *
 * The two local bundlers (`toggleProps`, `slotProps`) collapse the
 * `enabled`/`onToggle` and `slotLabel`/`slotDepth`/`onSlotDepthChange` wiring
 * that every field card repeats per-identifier — that repetition was the main
 * reason the inline array read as a wall of dense, near-identical JSX.
 */
import type { TFunc } from "../../../i18n/context.js";
import type { CanvasItem, CharacterCanvasDraft, PromptCanvasDraft } from "./canvas-shared.js";
import { EditablePromptCard } from "./rows/EditablePromptCard.js";
import { EditableAuthorNoteCard } from "./rows/EditableAuthorNoteCard.js";
import { PromptOrderMarker } from "./rows/PromptOrderMarker.js";
import { CharacterFieldCard } from "./rows/CharacterFieldCard.js";

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

/** Per-identifier `enabled` + `onToggle` — every card (field, author-note,
 *  character, marker) takes this pair. */
type ToggleProps = { enabled: boolean; onToggle: (identifier: string) => void };

/** Per-identifier slot-position props — the three field-card-only position
 *  controls (label + depth + depth-change). Markers do NOT take these. */
type SlotProps = {
  slotLabel: string | null;
  slotDepth: number | null;
  onSlotDepthChange: (depth: number) => void;
};

export function buildFixedItems(ctx: FixedItemCtx): CanvasItem[] {
  const {
    t,
    draft,
    onUpdateField,
    characterDraft,
    onCharacterFieldUpdate,
    slotEnabled,
    togglePromptSlot,
    slotLabelFor,
    slotDepthFor,
    updateSlotDepth,
  } = ctx;

  const toggleProps = (id: string): ToggleProps => ({ enabled: slotEnabled(id), onToggle: togglePromptSlot });

  const slotProps = (id: string): SlotProps => ({
    slotLabel: slotLabelFor(id),
    slotDepth: slotDepthFor(id),
    onSlotDepthChange: (d: number) => updateSlotDepth(id, d),
  });

  return [
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 0, render: () => <EditablePromptCard identifier="main" {...toggleProps("main")} {...slotProps("main")} label={t("system_prompt")} role="system" value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("system", value)} /> },
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 10, render: () => <PromptOrderMarker identifier="worldInfoBefore" label={t("prompt_slot_world_info_before")} tooltip={t("prompt_slot_world_info_before_hint")} kind="marker" {...toggleProps("worldInfoBefore")} /> },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 20, render: () => <PromptOrderMarker identifier="personaDescription" label={t("prompt_slot_persona")} kind="builtIn" {...toggleProps("personaDescription")} /> },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 30, render: () => <PromptOrderMarker identifier="charDescription" label={t("prompt_slot_character_description")} kind="builtIn" {...toggleProps("charDescription")} /> },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 40, render: () => <PromptOrderMarker identifier="charPersonality" label={t("prompt_slot_character_personality")} kind="builtIn" {...toggleProps("charPersonality")} /> },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 50, render: () => <PromptOrderMarker identifier="scenario" label={t("scenario")} kind="builtIn" {...toggleProps("scenario")} /> },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => <EditableAuthorNoteCard identifier="authorsNote" {...toggleProps("authorsNote")} draft={draft} onUpdateField={onUpdateField} {...slotProps("authorsNote")} /> },
    { key: "field:enhanceDefinitions", identifier: "enhanceDefinitions", kind: "field", defaultOrder: 70, render: () => <EditablePromptCard identifier="enhanceDefinitions" {...toggleProps("enhanceDefinitions")} {...slotProps("enhanceDefinitions")} label={t("enhance_definitions")} role="system" value={draft?.enhanceDefinitions ?? ""} placeholder={t("enhance_definitions_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("enhanceDefinitions", value)} /> },
    { key: "field:nsfw", identifier: "nsfw", kind: "field", defaultOrder: 75, render: () => <EditablePromptCard identifier="nsfw" {...toggleProps("nsfw")} {...slotProps("nsfw")} label={t("nsfw_prompt")} role="system" value={draft?.nsfw ?? ""} placeholder={t("nsfw_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("nsfw", value)} /> },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 80, render: () => <PromptOrderMarker identifier="worldInfoAfter" label={t("prompt_slot_world_info_after")} tooltip={t("prompt_slot_world_info_after_hint")} kind="marker" {...toggleProps("worldInfoAfter")} /> },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 90, render: () => <PromptOrderMarker identifier="dialogueExamples" label={t("prompt_slot_dialogue_examples")} kind="marker" {...toggleProps("dialogueExamples")} /> },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 110, render: () => <EditablePromptCard identifier="jailbreak" {...toggleProps("jailbreak")} {...slotProps("jailbreak")} label={t("post_history_instructions")} role="system" value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("jailbreak", value)} /> },
    { key: "field:assistantPrefill", identifier: "assistantPrefill", kind: "field", defaultOrder: 999, render: () => <EditablePromptCard identifier="assistantPrefill" {...toggleProps("assistantPrefill")} label={t("prefill_assistant")} role="assistant" value={draft?.prefill ?? ""} placeholder={t("prefill_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("prefill", value)} draggable={false} /> },

    // Character V3 overrides — only shown when the character has these fields
    ...(characterDraft ? [{ key: "char:systemPrompt", identifier: "charSystemPrompt", kind: "field" as const, defaultOrder: 1, render: () => <CharacterFieldCard identifier="charSystemPrompt" {...toggleProps("charSystemPrompt")} {...slotProps("charSystemPrompt")} label={t("character_system_prompt")} role="system" value={characterDraft.charSystemPrompt} onChange={(v) => onCharacterFieldUpdate?.("charSystemPrompt", v)} /> }] : []),
    ...(characterDraft ? [{ key: "char:postHistory", identifier: "charPostHistory", kind: "field" as const, defaultOrder: 115, render: () => <CharacterFieldCard identifier="charPostHistory" {...toggleProps("charPostHistory")} {...slotProps("charPostHistory")} label={t("character_post_history")} role="system" value={characterDraft.charPostHistory} onChange={(v) => onCharacterFieldUpdate?.("charPostHistory", v)} /> }] : []),
    ...(characterDraft ? [{ key: "char:depthPrompt", identifier: "charDepthPrompt", kind: "field" as const, defaultOrder: 65, render: () => <CharacterFieldCard identifier="charDepthPrompt" {...toggleProps("charDepthPrompt")} {...slotProps("charDepthPrompt")} label={t("character_depth_prompt")} role={characterDraft.charDepthPromptRole || "system"} value={characterDraft.charDepthPrompt} onChange={(v) => onCharacterFieldUpdate?.("charDepthPrompt", v)} depth={characterDraft.charDepthPromptDepth} onDepthChange={(d) => onCharacterFieldUpdate?.("charDepthPromptDepth", d)} onRoleChange={(r) => onCharacterFieldUpdate?.("charDepthPromptRole", r)} /> }] : []),
  ];
}
