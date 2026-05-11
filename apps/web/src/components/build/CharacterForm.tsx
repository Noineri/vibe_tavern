import { useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@rp-platform/api-contracts";
import { Ic } from "../shared/icons";
import { cn } from "../../lib/cn";
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
  onAvatarUpload: (file: File) => Promise<void> | void;

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

/* ── shared inline style objects (avoids Tailwind v4 numeric spacing bugs) ── */
const s = {
  fieldWrap: { marginBottom: 20 } as React.CSSProperties,
  label: { marginBottom: 6, display: "block" } as React.CSSProperties,
  inputPadding: { padding: "6px 10px" } as React.CSSProperties,
  sectionGap: { marginTop: 24, marginBottom: 12, paddingBottom: 6 } as React.CSSProperties,
};

const inputCls = "w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent";
const textareaCls = inputCls;
const monoCls = inputCls + " font-mono text-xs";

/** Small inline token badge for character form fields */
function TokenBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  const { t } = useT();
  return <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} {t("tokens_label")}</span>;
}

export function CharacterForm({
  form, avatarPreview, setAvatarPreview, isDirty, isSaving, avatarUrl, onSave, onReset, onAvatarUpload,
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

  // Total character tokens (all text fields)
  const charTotal = useTokenCount([
    description, firstMessage, mesExample, scenario,
    personalitySummary, postHistoryInstructions, creatorNotes,
    systemPrompt, depthPrompt,
    ...alternateGreetings,
  ].filter(Boolean).join("\n"));

  return (
    <div style={{ maxWidth: 600 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div className="font-body text-[22px] font-medium text-t1" style={{ marginBottom: 6 }}>
          {name || t("unnamed")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="font-ui text-[11px] tabular-nums text-t3">{charTotal.toLocaleString()} {t("tokens_label")}</span>
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
        <div className="rounded-md border border-border2 bg-s2 font-ui text-xs text-red-400" style={{ marginBottom: 12, padding: "6px 12px" }}>
          {importError}
        </div>
      )}

      {/* Validation error for name */}
      {errors.name && (
        <div className="rounded-md border border-border2 bg-s2 font-ui text-xs text-red-400" style={{ marginBottom: 12, padding: "6px 12px" }}>
          {errors.name.message}
        </div>
      )}

      <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t2" style={{ marginBottom: 28, lineHeight: 1.55 }}>
      </div>

      {/* Avatar + Name */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        <div
          className="group relative flex shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
          style={{ height: 64, width: 64 }}
          onClick={() => avaInputRef.current?.click()}
          title={t("change_avatar")}
        >
          <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => handleAvatarPick(e.target.files)} />
          {displayAvatar ? (
            <>
              <img src={displayAvatar} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
            </>
          ) : <Ic.plus />}
        </div>
        <div style={{ flex: 1 }}>
          <label className={lblCls} style={s.label}>{t("char_name_label")}</label>
          <input type="text" className={inputCls} style={s.inputPadding} disabled={isSaving} {...register("name")} />
        </div>
      </div>

      {/* Description */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("char_desc_label")}</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 100 }} disabled={isSaving} {...register("description")} />
        <TokenBadge text={description || ""} />
      </div>

      {/* First Message */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("first_message_greeting")}</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 120 }} disabled={isSaving} placeholder={t("first_message_placeholder")} {...register("firstMessage")} />
        <TokenBadge text={firstMessage || ""} />
      </div>

      {/* Alternate Greetings */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("alternate_greetings")}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {alternateGreetings.map((_: string, idx: number) => (
            <span
              key={idx}
              className={cn(
                "inline-flex items-center rounded border border-border bg-s2 font-ui text-xs text-t2 cursor-pointer transition-all",
                idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t",
              )}
              style={{ padding: "2px 10px", gap: 4 }}
              onClick={() => setAltGreetIdx(idx)}
            >
              Alt {idx + 1}
              <span style={{ marginLeft: 2, fontSize: 10 }} className="cursor-pointer" onClick={(e) => {
                e.stopPropagation();
                const next = [...alternateGreetings]; next.splice(idx, 1);
                setValue("alternateGreetings", next, { shouldDirty: true });
                if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
              }}>✕</span>
            </span>
          ))}
          <span
            className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent font-ui text-xs text-t3 cursor-pointer"
            style={{ padding: "2px 10px" }}
            onClick={() => {
              const next = [...alternateGreetings, ""];
              setValue("alternateGreetings", next, { shouldDirty: true });
              setAltGreetIdx(next.length - 1);
            }}
          >+</span>
        </div>
        {alternateGreetings.length > 0 && (
          <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 120 }} disabled={isSaving} value={alternateGreetings[altGreetIdx] || ""} onChange={(e) => {
            const next = [...alternateGreetings]; next[altGreetIdx] = e.target.value;
            setValue("alternateGreetings", next, { shouldDirty: true });
          }} placeholder={t("alternate_greeting_placeholder")} />
        )}
      </div>

      {/* Message Examples */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("dialog_examples")}</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 120 }} disabled={isSaving} placeholder="<START>..." {...register("mesExample")} />
        <TokenBadge text={mesExample || ""} />
      </div>

      {/* Scenario */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("scenario")}</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 100 }} disabled={isSaving} {...register("scenario")} />
        <TokenBadge text={scenario || ""} />
      </div>

      {/* Personality Summary */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("char_personality_label")}</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 60 }} disabled={isSaving} {...register("personalitySummary")} />
        <TokenBadge text={personalitySummary || ""} />
      </div>

      {/* Advanced separator */}
      <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3" style={s.sectionGap}>
        Advanced Fields (V3)
      </div>

      {/* Post-History Instructions */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("post_history_instructions")}</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 60 }} disabled={isSaving} placeholder={t("post_history_placeholder")} {...register("postHistoryInstructions")} />
        <TokenBadge text={postHistoryInstructions || ""} />
      </div>

      {/* Creator Notes */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("creator_notes")}</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 60 }} disabled={isSaving} placeholder={t("creator_notes_placeholder")} {...register("creatorNotes")} />
        <TokenBadge text={creatorNotes || ""} />
      </div>

      {/* Depth Prompt */}
      <div style={s.fieldWrap}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <label className={lblCls} style={{ marginBottom: 0 }}>{t("depth_prompt")}</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
              <input type="number" className={inputCls} style={{ padding: "2px 6px", width: 56, height: 24, textAlign: "center", fontSize: 11 }} min={0} max={999} disabled={isSaving} value={depthPromptDepth ?? 4} onChange={(e) => setValue("depthPromptDepth", Number(e.target.value), { shouldDirty: true })} />
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("role")}</span>
              <select className={inputCls} style={{ padding: "2px 6px", width: 82, height: 24, fontSize: 11 }} value={depthPromptRole || "system"} disabled={isSaving} onChange={(e) => setValue("depthPromptRole", e.target.value, { shouldDirty: true })}>
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </div>
          </div>
        </div>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 60 }} disabled={isSaving} placeholder={t("depth_prompt_placeholder")} {...register("depthPrompt")} />
        <TokenBadge text={depthPrompt || ""} />
      </div>

      {/* System Prompt Override */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("system_prompt_override")}</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 80 }} disabled={isSaving} placeholder={t("system_prompt_override_placeholder")} {...register("systemPrompt")} />
        <TokenBadge text={systemPrompt || ""} />
      </div>

      {/* Tags */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>{t("char_tags_label")}</label>
        <input type="text" className={inputCls} style={s.inputPadding} value={tagInput} disabled={isSaving} onChange={(e) => setTagInput(e.target.value)} onKeyDown={handleTagKey} placeholder={t("tags_enter")} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {tags.map((tag: string) => (
            <span key={tag} className="cursor-pointer rounded bg-accent-dim font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" style={{ padding: "4px 10px" }} onClick={() => toggleTag(tag)}>
              {tag} ✕
            </span>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button className="cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" style={{ height: 28, padding: "0 12px" }} disabled={isSaving || !isDirty} onClick={onReset}>{t("reset")}</button>
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
