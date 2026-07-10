/**
 * LoreEntryEditor — editing form for a single lorebook entry.
 *
 * Owns the field rendering for a `LoreEntryRecord`. Self-contained feature
 * blocks were extracted into sibling files (behavior-preserving — see
 * reports/lorebook-editor-form-state-gap.md Step 1): `ActivationTestPanel`
 * (the activation tester), `CharacterFilterPicker` (the id-bound character
 * filter), and `LoreKeysAiPill` (AI key generation). This component keeps the
 * local UI state for keyword input (keyInput / secKeyInput), the advanced-
 * settings disclosure (advancedOpen), the AI helper modal (aiHelperOpen),
 * and the delete-confirmation modal (confirmDeleteEntry).
 *
 * Receives from the parent:
 *   - entry (entry data)
 *   - updateAct (callback for changing fields → autosave)
 *   - onDeleted (callback after successful deletion)
 */
import { useState, type ReactNode } from "react";
import { useFormContext, useController, type FieldPath, type UseControllerReturn } from "react-hook-form";
import { useKeyDown } from "../../../hooks/use-key-down.js";
import { FieldLabel } from "../fields/field-label.js";

import { useActiveCharacter, useActivePersona } from "../../../stores/snapshot-store.js";
import { Ic, Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { ToggleChips } from "../../shared/ToggleChips.js";
import { Toggle } from "../../shared/Toggle.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import {
  deleteLoreEntry,
  type LoreEntryRecord,
} from "../../../app-client.js";
import { LoreKeysAiPill } from "./lore-keys-ai-pill.js";
import { ActivationTestPanel } from "./activation-test-panel.js";
import { CharacterFilterPicker } from "./character-filter-picker.js";

// ── Types ──────────────────────────────────────────────────────────────

interface LoreEntryEditorProps {
  entry: LoreEntryRecord;
  entryId: string;
  lorebookId: string;
  updateAct: (field: string, value: unknown) => void;
  onDeleted: () => void;
  isMobile: boolean;
  t: TFunc;
  /** Existing group names in the same lorebook, for the group-name autocomplete. */
  existingGroups?: string[];
}

// ── Controlled field binding ───────────────────────────────────────────

/**
 * Binds a controlled component (value / checked + onChange(value)) to a
 * top-level form field — a thin render-prop over `useController` so the ~25
 * custom inputs (NumberInput, Checkbox, Toggle, SegmentedControl, …) bind
 * without repeating the Controller scaffolding per field, and each field
 * re-renders only on its own change (scoped subscription, not a whole-editor
 * re-render). Native text inputs keep using `register` directly.
 */
function ControlledField<P extends FieldPath<LoreEntryRecord>>({
  name,
  children,
}: {
  name: P;
  children: (field: UseControllerReturn<LoreEntryRecord, P>["field"]) => ReactNode;
}) {
  const { control } = useFormContext<LoreEntryRecord>();
  const { field } = useController<LoreEntryRecord, P>({ control, name });
  return <>{children(field)}</>;
}

// ── Component ──────────────────────────────────────────────────────────

export function LoreEntryEditor({
  entry,
  entryId,
  lorebookId,
  updateAct,
  onDeleted,
  isMobile,
  t,
  existingGroups,
}: LoreEntryEditorProps) {
  const { tDynamic } = useT();
  // Active-entry form (lifted to LorebookEditor in Step 2, provided via
  // <FormProvider>). Step 4 binds fields to it directly (register / Controller),
  // retiring the entry-prop + updateAct round-trip field by field.
  const form = useFormContext<LoreEntryRecord>();
  // content is read in several places (the textareas via Controller below, plus
  // TokenCounter + AiAssistantModal) — watch it once so they stay live.
  const content = form.watch("content");
  // ── Local UI state ──
  const [keyInput, setKeyInput] = useState("");
  const [secKeyInput, setSecKeyInput] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(false);
  useKeyDown("Escape", () => setConfirmDeleteEntry(false), { enabled: confirmDeleteEntry });

  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const activeCharacter = useActiveCharacter();
  const activePersona = useActivePersona();

  // ── Keyword handlers ──
  const handleKeyAdd = (
    e: React.KeyboardEvent,
    type: "keys" | "secondaryKeys"
  ) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const val = (type === "keys" ? keyInput : secKeyInput).trim();
    if (!val) return;
    const arr = entry[type];
    if (!arr.includes(val)) updateAct(type, [...arr, val]);
    type === "keys" ? setKeyInput("") : setSecKeyInput("");
  };

  const removeKey = (type: "keys" | "secondaryKeys", keyToRemove: string) => {
    const arr = entry[type];
    updateAct(type, arr.filter((k) => k !== keyToRemove));
  };

  // ── Delete entry ──
  const handleDelete = async () => {
    // Close the confirm modal first (matches the shared-modal convention used
    // by VersionSwitcher / GalleryGrid: close-on-confirm, fire delete in the
    // background). The deletingEntry/disabled flag is no longer needed — the
    // confirm button unmounts immediately, so there is no double-click risk.
    setConfirmDeleteEntry(false);
    await deleteLoreEntry(lorebookId, entryId);
    onDeleted();
  };

  return (
    <>
      <div className="mx-auto max-w-[860px] flex flex-col gap-6">
        {/* ── Header: name + enabled toggle + delete ── */}
        <div className="flex items-center gap-3">
          <input
            className="flex-1 rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[15px] font-semibold text-t1 outline-none focus:border-accent"
            type="text"
            placeholder={t("lore_entry_title")}
            {...form.register("title")}
          />
          <Toggle
            checked={entry.enabled}
            onChange={(v) => updateAct("enabled", v)}
            className="ml-1"
          />
          <CustomTooltip content={t("lore_save_entry")}>
            <button type="button"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-danger"
              onClick={() => setConfirmDeleteEntry(true)}
            >
              <Ic.del />
            </button>
          </CustomTooltip>
        </div>

        {/* ── Keywords ── */}
        <div>
          <FieldLabel>
            {t("lore_entry_keys")}
          </FieldLabel>
          <div className="flex items-start gap-2">
            <div
              className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
              style={{ minHeight: 38 }}
            >
              {entry.keys.map((k) => (
                <span
                  key={k}
                  className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => removeKey("keys", k)}
                >
                  {k} <Icons.Close />
                </span>
              ))}
              <input
                className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-t1 outline-none"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => handleKeyAdd(e, "keys")}
                placeholder={
                  entry.keys.length === 0
                    ? t("lore_entry_keys_placeholder")
                    : ""
                }
              />
            </div>
            <LoreKeysAiPill entry={entry} updateAct={updateAct} />
          </div>
        </div>

        {/* ── Activation flags (always visible, not in advanced mode) ── */}
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <CustomTooltip content={t("constant_hint")} align="start">
            <Checkbox
              checked={entry.constant}
              onChange={(v) => updateAct("constant", v)}
              label={t("lore_constant")}
            />
          </CustomTooltip>
          <CustomTooltip content={t("case_sensitive_hint")} align="start">
            <Checkbox
              checked={entry.caseSensitive}
              onChange={(v) => updateAct("caseSensitive", v)}
              label={t("lore_case_sensitive")}
            />
          </CustomTooltip>
          <CustomTooltip content={t("match_whole_words_hint")} align="start">
            <Checkbox
              checked={entry.matchWholeWords}
              onChange={(v) => updateAct("matchWholeWords", v)}
              label={t("lore_match_whole_words")}
            />
          </CustomTooltip>
          <CustomTooltip content={t("ignore_budget_hint")} align="start">
            <Checkbox
              checked={entry.ignoreBudget}
              onChange={(v) => updateAct("ignoreBudget", v)}
              label={t("lore_ignore_budget")}
            />
          </CustomTooltip>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
            onClick={() => setAiHelperOpen(true)}
          >
            <Ic.brain /> {t("script_ai_helper")}
          </button>
        </div>

        {/* ── Content + activation test ── */}
        <div>
          <FieldLabel>
            {t("lore_entry_content")}
          </FieldLabel>
          <ControlledField name="content">
            {(field) => (
              <MobileExpandTextarea
                value={field.value}
                onChange={field.onChange}
                label={t("lore_entry_content")}
              >
                <AutoTextarea
                  className="w-full min-h-[180px] rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[13px] text-t1 outline-none focus:border-accent leading-[1.6]"
                  style={{}}
                  maxRows={25}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder={t("lore_entry_content_placeholder")}
                />
              </MobileExpandTextarea>
            )}
          </ControlledField>
          <TokenCounter text={content} />
        </div>

        <ActivationTestPanel lorebookId={lorebookId} isMobile={isMobile} t={t} />

        {/* ── Advanced settings toggle ── */}
        <button type="button"
          className="flex items-center gap-1.5 text-[13px] font-medium text-accent-t transition-all hover:text-accent"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <span className="text-[10px]">{advancedOpen ? "▲" : "▼"}</span>
          {advancedOpen
            ? t("lore_advanced_collapse")
            : t("lore_advanced_settings")}
        </button>

        {/* ── Advanced settings ── */}
        {advancedOpen && (
          <div
            className="flex flex-col gap-0"
            style={{
              paddingBottom: isMobile
                ? "calc(2rem + env(safe-area-inset-bottom, 0px))"
                : undefined,
            }}
          >
            {/* ── Logic + Role ── */}
            <div className="flex flex-wrap gap-4 mb-6">
              <div>
                <FieldLabel>
                  {t("lore_logic_label")}
                </FieldLabel>
                <SegmentedControl
                  value={entry.logic}
                  options={[
                    { value: "and_any", label: t("lore_logic_any"), tooltip: t("lore_logic_any_hint") },
                    { value: "and_all", label: t("lore_logic_all"), tooltip: t("lore_logic_all_hint") },
                    { value: "not_any", label: t("lore_logic_none"), tooltip: t("lore_logic_none_hint") },
                    { value: "not_all", label: t("lore_logic_not_all"), tooltip: t("lore_logic_not_all_hint") },
                  ]}
                  onChange={(v) => updateAct("logic", v)}
                  compact
                />
              </div>
              <div>
                <FieldLabel>
                  {t("lore_role_label")}
                </FieldLabel>
                  <SegmentedControl
                    value={entry.role}
                    options={[
                      { value: "system", label: t("lore_role_system") },
                      { value: "user", label: t("lore_role_user") },
                      { value: "assistant", label: t("lore_role_assistant") },
                    ]}
                    onChange={(v) => updateAct("role", v)}
                    compact
                  />
                </div>
            </div>

            {/* ── Secondary keywords ── */}
            <div className="mb-6">
              <FieldLabel>
                {t("lore_entry_secondary_keys")}
              </FieldLabel>
              <div
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
                style={{ minHeight: 38 }}
              >
                {entry.secondaryKeys.map((k) => (
                  <span
                    key={k}
                    className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                    onClick={() => removeKey("secondaryKeys", k)}
                  >
                    {k} <Icons.Close />
                  </span>
                ))}
                <input
                  className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-t1 outline-none"
                  value={secKeyInput}
                  onChange={(e) => setSecKeyInput(e.target.value)}
                  onKeyDown={(e) => handleKeyAdd(e, "secondaryKeys")}
                />
              </div>
            </div>

            {/* ── Position ── */}
            <div className="mb-6 pb-6 border-b border-border/50">
              <CustomTooltip content={t("lore_position_hint")} side="right" align="start">
                <div className="mb-3 inline-flex cursor-help items-center gap-1 text-[13px] font-medium text-t1">
                  {t("lore_position_label")}
                  <span className="text-[11px] text-t3">?</span>
                </div>
              </CustomTooltip>

              <div
                className={cn(
                  "grid gap-1.5 mb-4",
                  isMobile ? "grid-cols-2" : "grid-cols-4"
                )}
              >
                {(
                  [
                    "before_char",
                    "after_char",
                    "before_examples",
                    "after_examples",
                    "top_an",
                    "bottom_an",
                    "at_depth",
                    "outlet",
                  ] as const
                ).map((pos) => (
                  <CustomTooltip key={pos} content={tDynamic("pos_" + pos + "_hint")} side="top">
                    <button
                      type="button"
                      onClick={() => updateAct("position", pos)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px] font-ui font-medium transition-all",
                        entry.position === pos
                          ? "border-accent bg-accent-dim text-accent-t"
                          : "border-border bg-s3 text-t2 hover:border-t3 hover:text-t1"
                      )}
                    >
                      {tDynamic("pos_" + pos)}
                    </button>
                  </CustomTooltip>
                ))}
              </div>

              {(entry.position === "at_depth" ||
                entry.position === "top_an" ||
                entry.position === "bottom_an") && (
                <div className="max-w-[170px]">
                  <CustomTooltip content={t("lore_depth_hint")} side="top" align="start">
                    <div>
                      <FieldLabel help>
                        {t("lore_depth_label")}
                      </FieldLabel>
                      <NumberInput
                        min={0}
                        value={entry.depth}
                        onChange={(v) => updateAct("depth", v)}
                      />
                    </div>
                  </CustomTooltip>
                </div>
              )}
            </div>

            {/* ── Match sources ── */}
            <div className="mb-6">
              <FieldLabel>
                {t("lore_matchsources_section")}
              </FieldLabel>
              <ToggleChips
                selected={entry.matchSources}
                options={(
                  [
                    "chat_messages",
                    "character_desc",
                    "character_personality",
                    "character_note",
                    "persona_desc",
                    "scenario",
                    "creator_notes",
                  ] as const
                ).map((src) => ({
                  value: src,
                  label: tDynamic("match_src_" + src),
                }))}
                onChange={(v) => updateAct("matchSources", v)}
              />
            </div>

            {/* ── Priority + Probability + Scan depth ── */}
            <div
              className={cn(
                "grid gap-4 mb-6 pb-6 border-b border-border/50",
                isMobile && "grid-cols-1"
              )}
              style={{
                gridTemplateColumns: isMobile
                  ? undefined
                  : "repeat(auto-fill, minmax(170px, 1fr))",
              }}
            >
              <CustomTooltip content={t("lore_priority_hint")} side="top" align="start">
                <div>
                  <FieldLabel help>
                    {t("lore_priority_label")}
                  </FieldLabel>
                  <NumberInput
                    min={0}
                    value={entry.priority}
                    onChange={(v) => updateAct("priority", v)}
                  />
                </div>
              </CustomTooltip>
              <div>
                <CustomTooltip content={t("probability_hint")}>
                  <FieldLabel>
                    {t("lore_probability")}
                  </FieldLabel>
                </CustomTooltip>
                <NumberInput
                  min={0}
                  max={100}
                  value={entry.probability}
                  onChange={(v) => updateAct("probability", v)}
                />
              </div>
              <div>
                <CustomTooltip content={t("scan_depth_override_hint")}>
                  <FieldLabel>
                    {t("lore_scan_depth_override")}
                  </FieldLabel>
                </CustomTooltip>
                <NumberInput
                  min={-1}
                  value={entry.scanDepthOverride ?? -1}
                  onChange={(v) => updateAct("scanDepthOverride", v)}
                />
              </div>
            </div>

            {/* ── Inclusion group ── */}
            <div className="mb-6 pb-6 border-b border-border/50">
              <div
                className={cn(
                  "flex flex-wrap gap-4 items-end",
                  isMobile && "flex-col items-stretch"
                )}
              >
                <div className="min-w-[140px] flex-1 max-w-[200px]">
                  <CustomTooltip content={t("group_hint")}>
                    <FieldLabel>
                      {t("lore_group_name")}
                    </FieldLabel>
                  </CustomTooltip>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="text"
                    {...form.register("groupName")}
                  />
                </div>
                <div className="min-w-[100px]">
                  <CustomTooltip content={t("group_weight_hint")}>
                    <FieldLabel>
                      {t("lore_group_weight")}
                    </FieldLabel>
                  </CustomTooltip>
                  <NumberInput
                    min={0}
                    value={entry.groupWeight}
                    onChange={(v) => updateAct("groupWeight", v)}
                  />
                </div>
                <CustomTooltip content={t("prioritize_inclusion_hint")} align="start">
                  <Checkbox
                    checked={entry.prioritizeInclusion}
                    onChange={(v) => updateAct("prioritizeInclusion", v)}
                    label={t("lore_prioritize_inclusion")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("group_scoring_hint")} align="start">
                  <Checkbox
                    checked={entry.useGroupScoring}
                    onChange={(v) => updateAct("useGroupScoring", v)}
                    label={t("lore_use_group_scoring")}
                  />
                </CustomTooltip>
              </div>
              {existingGroups && existingGroups.filter((g) => g !== entry.groupName).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {existingGroups
                    .filter((g) => g !== entry.groupName)
                    .map((g) => (
                      <span
                        key={g}
                        className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                        onClick={() => updateAct("groupName", g)}
                      >
                        {g}
                      </span>
                    ))}
                </div>
              )}
            </div>

            <CharacterFilterPicker
              characterFilter={entry.characterFilter}
              characterFilterExclude={entry.characterFilterExclude}
              updateAct={updateAct}
              t={t}
            />

            {/* ── Temporary effects ── */}
            <div className="mb-6 pb-6 border-b border-border/50">
              <div className="mb-3 text-[13px] font-medium text-t1">
                {t("lore_timed_section")}
              </div>
              <div
                className={cn(
                  "grid gap-4",
                  isMobile && "grid-cols-1"
                )}
                style={{
                  gridTemplateColumns: isMobile
                    ? undefined
                    : "repeat(auto-fill, minmax(170px, 1fr))",
                }}
              >
                <CustomTooltip content={t("sticky_win_hint")}>
                  <div>
                    <FieldLabel>
                      {t("lore_sticky_window")}
                    </FieldLabel>
                    <NumberInput
                      min={0}
                      value={entry.stickyWindow}
                      onChange={(v) => updateAct("stickyWindow", v)}
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("cooldown_hint")}>
                  <div>
                    <FieldLabel>
                      {t("lore_cooldown_window")}
                    </FieldLabel>
                    <NumberInput
                      min={0}
                      value={entry.cooldownWindow}
                      onChange={(v) => updateAct("cooldownWindow", v)}
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("delay_hint")}>
                  <div>
                    <FieldLabel>
                      {t("lore_delay_window")}
                    </FieldLabel>
                    <NumberInput
                      min={0}
                      value={entry.delayWindow}
                      onChange={(v) => updateAct("delayWindow", v)}
                    />
                  </div>
                </CustomTooltip>
              </div>
            </div>

            {/* ── Recursion ── */}
            <div>
              <CustomTooltip content={t("lore_recursion_section_hint")} side="right" align="start">
                <div className="mb-3 inline-flex cursor-help items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.07em] text-t3">
                  {t("lore_recursion_section")}
                  <span className="text-[11px] normal-case tracking-normal text-t3">?</span>
                </div>
              </CustomTooltip>
              <div className="flex flex-wrap gap-4">
                <CustomTooltip content={t("exclude_recursion_hint")} align="start">
                  <Checkbox
                    checked={entry.excludeRecursion}
                    onChange={(v) => updateAct("excludeRecursion", v)}
                    label={t("lore_exclude_recursion")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("prevent_recursion_hint")} align="start">
                  <Checkbox
                    checked={entry.preventRecursion}
                    onChange={(v) => updateAct("preventRecursion", v)}
                    label={t("lore_prevent_recursion")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("delay_until_recursion_hint")} align="start">
                  <Checkbox
                    checked={entry.delayUntilRecursion}
                    onChange={(v) => updateAct("delayUntilRecursion", v)}
                    label={t("lore_delay_until_recursion")}
                  />
                </CustomTooltip>
              </div>
              {entry.delayUntilRecursion && (
                <div className="mt-3 max-w-[160px]">
                  <CustomTooltip content={t("recursion_level_hint")}>
                    <FieldLabel>
                      {t("lore_recursion_label")}
                    </FieldLabel>
                  </CustomTooltip>
                  <NumberInput
                    min={0}
                    value={entry.recursionLevel}
                    onChange={(v) => updateAct("recursionLevel", v)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AiAssistantModal
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        apiMode="lore_entry"
        existingContent={content}
        onReplace={(text) => form.setValue("content", text, { shouldDirty: true })}
        onInsert={(text) =>
          form.setValue(
            "content",
            content ? `${content.trimEnd()}\n\n${text}` : text,
            { shouldDirty: true },
          )
        }
        mode="full"
        scopeContext={{
          characterId: activeCharacter?.id,
          personaId: activePersona?.id,
        }}
      />

      {/* ── Entry delete confirmation modal ── */}
      {confirmDeleteEntry && (
        <DestructiveConfirmModal
          title={t("delete_entry_confirm")}
          body={t("delete_entry_msg")}
          confirmLabel={t("delete_entry_confirm")}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDeleteEntry(false)}
        />
      )}
    </>
  );
}
