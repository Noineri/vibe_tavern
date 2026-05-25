import { useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@rp-platform/api-contracts";
import { Ic } from "../shared/icons";

import { cn } from "../../lib/cn";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { CharacterImportModal } from "../ImportModals.js";
import { extractPngMetadata, parseCharacterMetadata } from "../../lib/png-reader";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";

export interface CharacterFormProps {
  form: UseFormReturn<BuildCharacterDraft>;
  avatarPreview: string | null;
  setAvatarPreview: (url: string | null) => void;
  isDirty: boolean;
  isSaving: boolean;
  avatarUrl?: string;
  onSave: () => void;
  onReset: () => void;
  onAvatarUpload: (file: File, originalFile?: File | null) => Promise<void> | void;
  onExportJson: () => void;
  onExportPng: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  hasAvatar: boolean;
}

function parseCardToDraft(raw: unknown): Partial<BuildCharacterDraft> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as Record<string, unknown>).data && typeof (raw as Record<string, unknown>).data === "object" ? (raw as Record<string, unknown>).data : raw;
  const d = data as Record<string, unknown>;
  const result: Partial<BuildCharacterDraft> = {};
  if (d.name) result.name = String(d.name);
  if (d.description) result.description = String(d.description);
  if (d.first_mes) result.firstMessage = String(d.first_mes);
  if (d.mes_example) result.mesExample = String(d.mes_example);
  if (d.mes_example_mode) result.mesExampleMode = String(d.mes_example_mode) as "always" | "once" | "depth";
  if (typeof d.mes_example_depth === "number") result.mesExampleDepth = d.mes_example_depth;
  if (d.scenario) result.scenario = String(d.scenario);
  if (d.personality) result.personalitySummary = String(d.personality);
  if (d.system_prompt) result.systemPrompt = String(d.system_prompt);
  if (d.post_history_instructions) result.postHistoryInstructions = String(d.post_history_instructions);
  if (d.creator_notes) result.creatorNotes = String(d.creator_notes);
  if (d.depth_prompt) result.depthPrompt = String(d.depth_prompt);
  if (typeof d.depth_prompt_depth === "number") result.depthPromptDepth = d.depth_prompt_depth;
  if (d.depth_prompt_role) result.depthPromptRole = String(d.depth_prompt_role);
  if (Array.isArray(d.alternate_greetings)) result.alternateGreetings = (d.alternate_greetings as string[]).map(String);
  if (Array.isArray(d.tags)) result.tags = (d.tags as string[]).map(String);
  return result;
}

/* ── shared style constants for padding (Tailwind v4 numeric spacing bugs) ── */
const inputPad = { padding: "6px 10px" } as React.CSSProperties;

const inputCls = "w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent resize-none overflow-hidden";
const monoCls = inputCls + " font-mono text-xs";

/** Styled inline select — matches the project style (TweaksPanel, ProviderEditHeader) */
const selectCls =
  "h-6 rounded-md border border-border bg-s2 pl-1.5 sel-arrow text-[11px] font-ui text-t1 outline-none focus:border-accent";

/** Small inline token badge for character form fields */
function TokenBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  const { t } = useT();
  return <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} {t("tokens_label")}</span>;
}

export function CharacterForm({
  form, avatarPreview, setAvatarPreview, isDirty, isSaving, avatarUrl, onSave, onReset, onAvatarUpload,
  onExportJson, onExportPng, onDuplicate, onDelete, hasAvatar,
}: CharacterFormProps) {
  const { t } = useT();
  const { register, formState: { errors }, watch, setValue, handleSubmit } = form;

  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState("");
  const [importError, setImportError] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const avaInputRef = useRef<HTMLInputElement>(null);



  const name = watch("name");
  const description = watch("description");
  const firstMessage = watch("firstMessage");
  const mesExample = watch("mesExample");
  const mesExampleMode = watch("mesExampleMode");
  const mesExampleDepth = watch("mesExampleDepth");
  const scenario = watch("scenario");
  const personalitySummary = watch("personalitySummary");
  const systemPrompt = watch("systemPrompt");
  const alternateGreetings = watch("alternateGreetings") || [];
  const postHistoryInstructions = watch("postHistoryInstructions");
  const creatorNotes = watch("creatorNotes");
  const depthPrompt = watch("depthPrompt");
  const depthPromptDepth = watch("depthPromptDepth");
  const depthPromptRole = watch("depthPromptRole");
  const tags = watch("tags") || [];

  const canSave = !isSaving && (name || "").trim();

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setAvatarPreview(URL.createObjectURL(file));
    onAvatarUpload(file);
  }

  function handleImportFiles(files: File[]): void {
    if (files.length === 0) return;
    const file = files[0];
    setImportError("");
    (async () => {
      try {
        let raw: unknown;
        const lowerName = file.name.toLowerCase();
        if (file.type === "image/png" || lowerName.endsWith(".png")) {
          const metadata = await extractPngMetadata(file);
          raw = parseCharacterMetadata(metadata);
        } else if (lowerName.endsWith(".json") || file.type === "application/json") {
          const text = await file.text();
          raw = JSON.parse(text);
        } else {
          throw new Error(t("unsupported_format_error"));
        }
        const merged = parseCardToDraft(raw);
        if (Object.keys(merged).length === 0) throw new Error(t("import_error_no_data"));
        form.reset({ ...form.getValues(), ...merged } as BuildCharacterDraft);
        setImportModalOpen(false);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : t("import_failed"));
      }
    })();
  }

  function toggleTag(tag: string) {
    const newTags = tags.includes(tag) ? tags.filter((t: string) => t !== tag) : [...tags, tag];
    setValue("tags", newTags, { shouldDirty: true });
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && tagInput.trim()) {
      e.preventDefault();
      if (!tags.includes(tagInput.trim())) setValue("tags", [...tags, tagInput.trim()], { shouldDirty: true });
      setTagInput("");
    }
  }

  const displayAvatar = avatarPreview || avatarUrl;
  const lblCls = "block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";

  // Token breakdown: permanent (all fields except greeting) + greeting
  const permanentTokens = useTokenCount([
    description, scenario, personalitySummary, mesExample,
    postHistoryInstructions, creatorNotes, systemPrompt, depthPrompt,
  ].filter(Boolean).join("\n"));
  const greetingTokens = useTokenCount(firstMessage || "");

  return (
    <div>
      {/* Header row */}
      <div className="mb-1.5 flex items-center justify-between">
        <div className="mb-1.5 font-body text-[22px] font-medium text-t1">
          {name || t("unnamed")}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-ui text-[11px] tabular-nums text-t3">
            {permanentTokens.toLocaleString()}<span className="text-t4">+</span>{greetingTokens.toLocaleString()} {t("tokens_label")}
          </span>
          <button
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            title={t("char_export_json")}
            onClick={onExportJson}
            disabled={isSaving}
          >
            {Ic.download()}
          </button>
          {hasAvatar && (
            <button
              className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
              style={{ height: 28, width: 28 }}
              title={t("char_export_png")}
              onClick={onExportPng}
              disabled={isSaving}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="8" cy="8" r="2"/><circle cx="5" cy="5" r="0.8" fill="currentColor"/></svg>
            </button>
          )}
          <button
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            title={t("char_duplicate")}
            onClick={onDuplicate}
            disabled={isSaving}
          >
            {Ic.copy()}
          </button>
          <button
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-danger hover:text-danger"
            style={{ height: 28, width: 28 }}
            title={t("char_delete")}
            onClick={onDelete}
            disabled={isSaving}
          >
            {Ic.del()}
          </button>
          <button
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            title={t("char_import_to_draft")}
            onClick={() => setImportModalOpen(true)}
            disabled={isSaving}
          >
            {Ic.import()}
          </button>
          <button
            className="cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
            style={{ height: 28, padding: "0 14px" }}
            disabled={!canSave || !isDirty}
            onClick={onSave}
          >
            {isSaving ? t("saving") : t("save")}
          </button>
        </div>
      </div>

      {importError && (
        <div className="mb-3 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-xs text-red-400">
          {importError}
        </div>
      )}

      {/* Validation error for name */}
      {errors.name && (
        <div className="mb-3 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-xs text-red-400">
          {errors.name.message}
        </div>
      )}

      <div className="mb-7 font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.55] text-t2">
      </div>

      {/* Avatar + Name + Tags */}
      <div className="mb-5 flex gap-5">
        <div
          className="group relative shrink-0 cursor-pointer rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
          style={{ maxWidth: 180, maxHeight: 250 }}
          onClick={() => avaInputRef.current?.click()}
          title={t("change_avatar")}
        >
          <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => handleAvatarPick(e.target.files)} />
          {displayAvatar ? (
            <>
              <img src={displayAvatar} alt="" className="block max-w-[180px]" style={{ maxHeight: 250, objectFit: "contain" }} />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
            </>
          ) : (
            <div className="flex h-20 w-28 flex-col items-center justify-center gap-1.5 text-t3 transition-colors group-hover:text-accent-t">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span className="font-ui text-[10px] tracking-wide">{t("upload_avatar")}</span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <label className={lblCls + " mb-1.5 block"}>{t("char_name_label")}</label>
            <input type="text" className={inputCls} style={inputPad} disabled={isSaving} {...register("name")} />
          </div>
          <div>
            <label className={lblCls + " mb-1.5 block"}>{t("char_tags_label")}</label>
            <input type="text" className={inputCls} style={inputPad} value={tagInput} disabled={isSaving} onChange={(e) => setTagInput(e.target.value)} onKeyDown={handleTagKey} placeholder={t("tags_enter")} />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((tag: string) => (
                <span key={tag} className="cursor-pointer rounded bg-accent-dim px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" onClick={() => toggleTag(tag)}>
                  {tag} ✕
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("char_desc_label")}</label>
        <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 100 }} disabled={isSaving} register={register("description")} />
        <TokenBadge text={description || ""} />
      </div>

      {/* First Message */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("first_message_greeting")}</label>
        <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} placeholder={t("first_message_placeholder")} register={register("firstMessage")} />
        <TokenBadge text={firstMessage || ""} />
      </div>

      {/* Alternate Greetings */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("alternate_greetings")}</label>
        <div className="mb-2 flex flex-wrap gap-1">
          {alternateGreetings.map((_: string, idx: number) => (
            <span
              key={idx}
              className={cn(
                "inline-flex items-center gap-1 rounded border border-border bg-s2 px-2.5 py-[2px] font-ui text-xs text-t2 cursor-pointer transition-all",
                idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t",
              )}
              onClick={() => setAltGreetIdx(idx)}
            >
              Alt {idx + 1}
              <span className="ml-0.5 cursor-pointer text-[10px]" onClick={(e) => {
                e.stopPropagation();
                const next = [...alternateGreetings]; next.splice(idx, 1);
                setValue("alternateGreetings", next, { shouldDirty: true });
                if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
              }}>✕</span>
            </span>
          ))}
          <span
            className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent px-2.5 py-[2px] font-ui text-xs text-t3 cursor-pointer"
            onClick={() => {
              const next = [...alternateGreetings, ""];
              setValue("alternateGreetings", next, { shouldDirty: true });
              setAltGreetIdx(next.length - 1);
            }}
          >+</span>
        </div>
        {alternateGreetings.length > 0 && (
          <div className="relative">
            <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} value={alternateGreetings[altGreetIdx] || ""} onChange={(e) => {
              const next = [...alternateGreetings]; next[altGreetIdx] = e.target.value;
              setValue("alternateGreetings", next, { shouldDirty: true });
            }} placeholder={t("alternate_greeting_placeholder")} />
            <div className="absolute right-0 top-0"><TokenBadge text={alternateGreetings[altGreetIdx] || ""} /></div>
          </div>
        )}
      </div>

      {/* Message Examples */}
      <div className="mb-5">
        <div className="mb-1.5 flex items-center justify-between">
          <label className={lblCls}>{t("dialog_examples")}</label>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("activation_label")}</span>
              <select
                className={selectCls}
                value={mesExampleMode || "always"}
                disabled={isSaving}
                title={t(`mes_example_mode_tooltip_${mesExampleMode || "always"}`)}
                onChange={(e) => setValue("mesExampleMode", e.target.value as "always" | "once" | "depth", { shouldDirty: true })}
              >
                <option value="always">{t("activation_always")}</option>
                <option value="once">{t("activation_once")}</option>
                <option value="depth">{t("activation_depth")}</option>
              </select>
            </div>
            <div className={"flex items-center gap-1" + ((mesExampleMode || "always") !== "depth" ? " opacity-30 pointer-events-none" : "")}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
              <input
                type="number"
                className="h-6 w-12 rounded-md border border-border bg-s2 px-1 text-center text-[11px] font-ui text-t1 outline-none focus:border-accent num-spinless"
                min={0}
                max={999}
                disabled={isSaving || (mesExampleMode || "always") !== "depth"}
                value={mesExampleDepth ?? 4}
                onChange={(e) => setValue("mesExampleDepth", Number(e.target.value), { shouldDirty: true })}
              />
            </div>
          </div>
        </div>
        <AutoTextarea className={monoCls} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} placeholder="<START>..." register={register("mesExample")} />
        <TokenBadge text={mesExample || ""} />
      </div>

      {/* Scenario */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("scenario")}</label>
        <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 100 }} disabled={isSaving} register={register("scenario")} />
        <TokenBadge text={scenario || ""} />
      </div>

      {/* Personality Summary */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("char_personality_label")}</label>
        <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 60 }} disabled={isSaving} register={register("personalitySummary")} />
        <TokenBadge text={personalitySummary || ""} />
      </div>

      {/* Advanced separator */}
      <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3 mt-6 mb-3 pb-1.5">
        Advanced Fields (V3)
      </div>

      {/* Post-History Instructions */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("post_history_instructions")}</label>
        <AutoTextarea className={monoCls} style={{ ...inputPad, minHeight: 60 }} disabled={isSaving} placeholder={t("post_history_placeholder")} register={register("postHistoryInstructions")} />
        <TokenBadge text={postHistoryInstructions || ""} />
      </div>

      {/* Creator Notes */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("creator_notes")}</label>
        <AutoTextarea className={inputCls} style={{ ...inputPad, minHeight: 60 }} disabled={isSaving} placeholder={t("creator_notes_placeholder")} register={register("creatorNotes")} />
        <TokenBadge text={creatorNotes || ""} />
      </div>

      {/* Depth Prompt */}
      <div className="mb-5">
        <div className="mb-1.5 flex items-center justify-between">
          <label className={lblCls}>{t("depth_prompt")}</label>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("role")}</span>
              <select
                className={selectCls}
                value={depthPromptRole || "system"}
                disabled={isSaving}
                onChange={(e) => setValue("depthPromptRole", e.target.value, { shouldDirty: true })}
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
              <input
                type="number"
                className="h-6 w-12 rounded-md border border-border bg-s2 px-1 text-center text-[11px] font-ui text-t1 outline-none focus:border-accent num-spinless"
                min={0}
                max={999}
                disabled={isSaving}
                value={depthPromptDepth ?? 4}
                onChange={(e) => setValue("depthPromptDepth", Number(e.target.value), { shouldDirty: true })}
              />
            </div>
          </div>
        </div>
        <AutoTextarea className={monoCls} style={{ ...inputPad, minHeight: 60 }} disabled={isSaving} placeholder={t("depth_prompt_placeholder")} register={register("depthPrompt")} />
        <TokenBadge text={depthPrompt || ""} />
      </div>

      {/* System Prompt Override */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("system_prompt_override")}</label>
        <AutoTextarea className={monoCls} style={{ ...inputPad, minHeight: 80 }} disabled={isSaving} placeholder={t("system_prompt_override_placeholder")} register={register("systemPrompt")} />
        <TokenBadge text={systemPrompt || ""} />
      </div>

      {/* Footer */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="h-7 cursor-pointer rounded-md bg-transparent px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" disabled={isSaving || !isDirty} onClick={onReset}>{t("reset")}</button>
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{isDirty ? t("unsaved_changes") : t("saved_state")}</span>
      </div>

      {importModalOpen && (
        <CharacterImportModal
          isImporting={false}
          onClose={() => setImportModalOpen(false)}
          onImportFiles={handleImportFiles}
        />
      )}
    </div>
  );
}
