import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons";

import { cn } from "../../../lib/cn";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CharacterImportModal } from "../../modals/ImportModals.js";
import { AiAssistantModal, type MdImportResult } from "../../shared/AiAssistantModal.js";
import { extractPngMetadata, parseCharacterMetadata } from "../../../lib/png-reader";
import { GalleryAccordion } from "./GalleryAccordion.js";
import { useTokenCount } from "../../../hooks/use-token-count.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { AvatarCropModal } from "../../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../../shared/AvatarCropModal.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { inputPad, inputCls, monoCls, lblCls } from "../fields/field-styles.js";
import { TextAreaField, TokenBadge } from "../fields/TextAreaField.js";
import { DepthPromptField } from "../fields/DepthPromptField.js";
import { TagsField } from "../fields/TagsField.js";

export interface CharacterFormProps {
  form: UseFormReturn<BuildCharacterDraft>;
  avatarPreview: string | null;
  setAvatarPreview: (url: string | null) => void;
  isDirty: boolean;
  isSaving: boolean;
  avatarUrl?: string;
  onSave: () => void;
  onReset: () => void;
  /** Вызывается после успешного импорта карточки (данные уже в форме, форма dirty) */
  onAfterImport?: () => void;
  onAvatarUpload: (file: File, originalFile?: File | null) => Promise<void> | void;
  onExportJson: () => void;
  onExportPng: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  hasAvatar: boolean;
  characterId: string;
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

export function CharacterForm({
  form, avatarPreview, setAvatarPreview, isDirty, isSaving, avatarUrl, onSave, onReset, onAvatarUpload,
  onAfterImport,
  onExportJson, onExportPng, onDuplicate, onDelete, hasAvatar, characterId
}: CharacterFormProps) {
  const { t } = useT();
  const { register, formState: { errors }, watch, setValue, handleSubmit } = form;

  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [importError, setImportError] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [mdImportOpen, setMdImportOpen] = useState(false);
  const avaInputRef = useRef<HTMLInputElement>(null);
  const [avatarOrientation, setAvatarOrientation] = useState<"portrait" | "landscape" | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);



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

  const canSave = !isSaving && (name || "").trim();
  const isMobile = useIsMobile();
  const mInput = isMobile ? " text-base" : "";

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setPendingAvatar({ file, url: URL.createObjectURL(file) });
  }

  function handleAvatarCropConfirm(result: AvatarCropResult) {
    const url = pendingAvatar!.url;
    setAvatarPreview(url);
    const img = new Image();
    img.onload = () => {
      setAvatarOrientation(img.naturalWidth > img.naturalHeight ? "landscape" : "portrait");
    };
    img.src = url;
    onAvatarUpload(result.croppedFile, pendingAvatar!.file);
    setPendingAvatar(null);
  }

  function handleAvatarCropCancel() {
    if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    setPendingAvatar(null);
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
        // Автосохранение + создание чата после импорта
        onAfterImport?.();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : t("import_failed"));
      }
    })();
  }

  function handleMdImportApply(fields: Partial<MdImportResult>) {
    const merged: Partial<BuildCharacterDraft> = {};
    if (fields.name) merged.name = fields.name;
    if (fields.tagline) merged.description = fields.tagline;
    if (fields.description) merged.description = (merged.description ? merged.description + "\n\n" : "") + fields.description;
    if (fields.personality) merged.personalitySummary = fields.personality;
    if (fields.scenario) merged.scenario = fields.scenario;
    if (fields.firstMessage) merged.firstMessage = fields.firstMessage;
    if (fields.alternateGreetings?.length) merged.alternateGreetings = fields.alternateGreetings;
    if (fields.exampleMessages?.length) merged.mesExample = fields.exampleMessages.join("\n<START>\n");
    if (fields.creatorNotes) merged.creatorNotes = fields.creatorNotes;
    if (Object.keys(merged).length > 0) {
      form.reset({ ...form.getValues(), ...merged } as BuildCharacterDraft);
      onAfterImport?.();
    }
  }

  const displayAvatar = avatarPreview || avatarUrl;

  // Detect orientation for existing avatar on mount
  useEffect(() => {
    if (!displayAvatar || avatarOrientation) return;
    const img = new Image();
    img.onload = () => {
      setAvatarOrientation(img.naturalWidth > img.naturalHeight ? "landscape" : "portrait");
    };
    img.src = displayAvatar;
  }, [displayAvatar, avatarOrientation]);

  // Token breakdown: permanent (all fields except greeting) + greeting
  const permanentTokens = useTokenCount([
    description, scenario, personalitySummary, mesExample,
    postHistoryInstructions, creatorNotes, systemPrompt, depthPrompt,
  ].filter(Boolean).join("\n"));
  const greetingTokens = useTokenCount(firstMessage || "");

  return (
    <div>
      {/* Header row */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="mb-1.5 font-body text-[22px] font-medium text-t1 min-w-0 truncate">
          {name || t("unnamed")}
        </div>
        {isMobile ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-ui text-[11px] tabular-nums text-t3">
              {permanentTokens.toLocaleString()}<span className="text-t4">+</span>{greetingTokens.toLocaleString()} {t("tokens_label")}
            </span>
            <button type="button"
              className="min-h-9 cursor-pointer rounded-md border-0 bg-accent px-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold text-on-accent transition-all disabled:opacity-40"
              disabled={!canSave || !isDirty}
              onClick={onSave}
            >
              {isSaving ? t("saving") : t("save")}
            </button>
          </div>
        ) : (
        <div className="flex items-center gap-2">
          <span className="font-ui text-[11px] tabular-nums text-t3">
            {permanentTokens.toLocaleString()}<span className="text-t4">+</span>{greetingTokens.toLocaleString()} {t("tokens_label")}
          </span>
          <CustomTooltip content={t("char_export_json")}>
          <button type="button"
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            onClick={onExportJson}
            disabled={isSaving}
          >
            {Ic.download()}
          </button>
          </CustomTooltip>
          {hasAvatar && (
            <CustomTooltip content={t("char_export_png")}>
            <button type="button"
              className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
              style={{ height: 28, width: 28 }}
              onClick={onExportPng}
              disabled={isSaving}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="8" cy="8" r="2"/><circle cx="5" cy="5" r="0.8" fill="currentColor"/></svg>
            </button>
            </CustomTooltip>
          )}
          <CustomTooltip content={t("char_duplicate")}>
          <button type="button"
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            onClick={onDuplicate}
            disabled={isSaving}
          >
            {Ic.copy()}
          </button>
          </CustomTooltip>
          <CustomTooltip content={t("char_delete")}>
          <button type="button"
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-danger hover:text-danger"
            style={{ height: 28, width: 28 }}
            onClick={onDelete}
            disabled={isSaving}
          >
            {Ic.del()}
          </button>
          </CustomTooltip>
          <CustomTooltip content={t("char_import_to_draft")}>
          <button type="button"
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            onClick={() => setImportModalOpen(true)}
            disabled={isSaving}
          >
            {Ic.import()}
          </button>
          </CustomTooltip>
          <CustomTooltip content={t("import_md_title")}>
          <button type="button"
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            onClick={() => setMdImportOpen(true)}
            disabled={isSaving}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2h6l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 2v4h4"/><path d="M6 10h4"/></svg>
          </button>
          </CustomTooltip>
          <button type="button"
            className="cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
            style={{ height: 28, padding: "0 14px" }}
            disabled={!canSave || !isDirty}
            onClick={onSave}
          >
            {isSaving ? t("saving") : t("save")}
          </button>
        </div>
        )}
      </div>
      {/* Mobile action bar */}
      {isMobile && (
        <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 active:bg-s3 [&_svg]:h-5 [&_svg]:w-5"
            onClick={() => setImportModalOpen(true)}
            disabled={isSaving}
          >
            {Ic.import()}
          </button>
          <button type="button"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 active:bg-s3"
            onClick={() => setMdImportOpen(true)}
            disabled={isSaving}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2h6l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 2v4h4"/><path d="M6 10h4"/></svg>
          </button>
          <button type="button"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 active:bg-s3 [&_svg]:h-5 [&_svg]:w-5"
            onClick={onExportJson}
            disabled={isSaving}
          >
            {Ic.download()}
          </button>
          {hasAvatar && (
            <button type="button"
              className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 active:bg-s3 [&_svg]:h-5 [&_svg]:w-5"
              onClick={onExportPng}
              disabled={isSaving}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="8" cy="8" r="2"/><circle cx="5" cy="5" r="0.8" fill="currentColor"/></svg>
            </button>
          )}
          <button type="button"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 active:bg-s3 [&_svg]:h-5 [&_svg]:w-5"
            onClick={onDuplicate}
            disabled={isSaving}
          >
            {Ic.copy()}
          </button>
          <button type="button"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-danger active:bg-danger/10 [&_svg]:h-5 [&_svg]:w-5"
            onClick={onDelete}
            disabled={isSaving}
          >
            {Ic.del()}
          </button>
        </div>
      )}

      {importError && (
        <div className="mb-3 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-xs text-danger-text">
          {importError}
        </div>
      )}

      {/* Validation error for name */}
      {errors.name && (
        <div className="mb-3 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-xs text-danger-text">
          {errors.name.message}
        </div>
      )}

      <div className="mb-7 font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.55] text-t2">
      </div>

      {/* Avatar + Name + Tags */}
      {avatarOrientation === "landscape" && displayAvatar ? (
        /* Landscape: full-width avatar above name/tags */
        <div className="mb-5 flex flex-col items-center gap-3">
          <CustomTooltip content={t("change_avatar")}>
          <div
            className="group relative cursor-pointer overflow-hidden rounded-lg"
            onClick={() => avaInputRef.current?.click()}
          >
            <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => handleAvatarPick(e.target.files)} />
            <img src={displayAvatar} alt="" className="block rounded-lg" style={{ maxWidth: isMobile ? 400 : 480, maxHeight: 280, objectFit: "contain" }} />
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
          </div>
          </CustomTooltip>
          <div className="w-full flex flex-col gap-3">
            <div>
              <label className={lblCls + " mb-1.5 block"}>{t("char_name_label")}</label>
              <input type="text" className={inputCls + mInput} style={inputPad} disabled={isSaving} {...register("name")} />
            </div>
            <TagsField form={form} isSaving={isSaving} />
          </div>
        </div>
      ) : (
      /* Portrait / no avatar: side-by-side layout */
      <div className={cn("mb-5 gap-5", isMobile ? "flex flex-col items-center" : "flex")}>
        <CustomTooltip content={t("change_avatar")}>
        <div
          className={cn(
            "group relative shrink-0 cursor-pointer rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t",
            isMobile ? "w-full max-w-[280px]" : "max-w-[180px]"
          )}
          style={isMobile ? { aspectRatio: "auto" } : { maxWidth: 180, maxHeight: 250 }}
          onClick={() => avaInputRef.current?.click()}
        >
          <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => handleAvatarPick(e.target.files)} />
          {displayAvatar ? (
            <>
              <img src={displayAvatar} alt="" className={cn("block", isMobile ? "w-full" : "max-w-[180px]")} style={isMobile ? undefined : { maxHeight: 250, objectFit: "contain" }} />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
            </>
          ) : (
            <div className={cn("flex flex-col items-center justify-center gap-1.5 text-t3 transition-colors group-hover:text-accent-t", isMobile ? "min-h-[120px] w-full" : "h-20 w-28")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span className="font-ui text-[10px] tracking-wide">{t("upload_avatar")}</span>
            </div>
          )}
        </div>
        </CustomTooltip>
        <div className={cn("flex min-w-0 flex-1 flex-col gap-3", isMobile && "w-full")}>
          <div>
            <label className={lblCls + " mb-1.5 block"}>{t("char_name_label")}</label>
            <input type="text" className={inputCls + mInput} style={inputPad} disabled={isSaving} {...register("name")} />
          </div>
          <TagsField form={form} isSaving={isSaving} />
        </div>
      </div>
      )}

      {/* Gallery Accordion */}
      <GalleryAccordion characterId={characterId} />

      {/* Description */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("char_desc_label")}</label>
        <MobileExpandTextarea value={description || ""} onChange={(v) => setValue("description", v)} label={t("char_desc_label")}>
          <AutoTextarea className={inputCls + mInput} style={{ ...inputPad, minHeight: 100 }} disabled={isSaving} register={register("description")} />
        </MobileExpandTextarea>
        <TokenBadge text={description || ""} />
      </div>

      {/* First Message */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("first_message_greeting")}</label>
        <MobileExpandTextarea value={firstMessage || ""} onChange={(v) => setValue("firstMessage", v)} label={t("first_message_label")}>
          <AutoTextarea className={inputCls + mInput} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} placeholder={t("first_message_placeholder")} register={register("firstMessage")} />
        </MobileExpandTextarea>
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
                isMobile && "min-h-[44px] px-3 py-1",
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
          <div>
            <AutoTextarea className={inputCls + mInput} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} value={alternateGreetings[altGreetIdx] || ""} onChange={(e) => {
              const next = [...alternateGreetings]; next[altGreetIdx] = e.target.value;
              setValue("alternateGreetings", next, { shouldDirty: true });
            }} placeholder={t("alternate_greeting_placeholder")} />
            <TokenBadge text={alternateGreetings[altGreetIdx] || ""} />
          </div>
        )}
      </div>

      {/* Message Examples */}
      <div className="mb-5">
        <div className="mb-1.5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className={lblCls}>{t("dialog_examples")}</label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-1 sm:min-w-fit">
              <CustomTooltip content={t(`mes_example_mode_tooltip_${mesExampleMode || "always"}`)}>
              <SegmentedControl
                value={mesExampleMode || "always"}
                options={[
                  { value: "always", label: t("activation_always") },
                  { value: "once", label: t("activation_once") },
                  { value: "depth", label: t("activation_depth") },
                  { value: "disabled", label: t("activation_disabled") },
                ]}
                onChange={(v) => setValue("mesExampleMode", v as "always" | "once" | "depth" | "disabled", { shouldDirty: true })}
                disabled={isSaving}
                compact
                mobileFill
              />
              </CustomTooltip>
            </div>
            <div className={"flex min-h-8 items-center justify-between gap-2 sm:justify-start" + ((mesExampleMode || "always") !== "depth" ? " opacity-30 pointer-events-none" : "")}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
              <NumberInput
                className="h-8 w-[100px] sm:h-6 sm:w-[90px]"
                min={0}
                max={999}
                disabled={isSaving || (mesExampleMode || "always") !== "depth"}
                value={mesExampleDepth ?? 4}
                onChange={(v) => setValue("mesExampleDepth", v, { shouldDirty: true })}
              />
            </div>
          </div>
        </div>
        <MobileExpandTextarea value={mesExample || ""} onChange={(v) => setValue("mesExample", v)} label={t("char_mes_example_label")}>
          <AutoTextarea className={monoCls + mInput} style={{ ...inputPad, minHeight: 120 }} disabled={isSaving} placeholder="<START>..." register={register("mesExample")} />
        </MobileExpandTextarea>
        <TokenBadge text={mesExample || ""} />
      </div>

      {/* Scenario */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("scenario")}</label>
        <MobileExpandTextarea value={scenario || ""} onChange={(v) => setValue("scenario", v)} label={t("char_scenario_label")}>
          <AutoTextarea className={inputCls + mInput} style={{ ...inputPad, minHeight: 100 }} disabled={isSaving} register={register("scenario")} />
        </MobileExpandTextarea>
        <TokenBadge text={scenario || ""} />
      </div>

      {/* Personality Summary */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("char_personality_label")}</label>
        <MobileExpandTextarea value={personalitySummary || ""} onChange={(v) => setValue("personalitySummary", v)} label={t("char_personality_summary_label")}>
          <AutoTextarea className={inputCls + mInput} style={{ ...inputPad, minHeight: 60 }} disabled={isSaving} register={register("personalitySummary")} />
        </MobileExpandTextarea>
        <TokenBadge text={personalitySummary || ""} />
      </div>

      {/* Advanced separator */}
      <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3 mt-6 mb-3 pb-1.5">
        {t("advanced_fields_v3")}
      </div>

      {/* Post-History Instructions */}
      <TextAreaField
        form={form}
        field="postHistoryInstructions"
        label={t("post_history_instructions")}
        mobileExpandLabel={t("post_history_label")}
        minHeight={60}
        mono
        placeholder={t("post_history_placeholder")}
        isSaving={isSaving}
      />

      {/* Creator Notes */}
      <TextAreaField
        form={form}
        field="creatorNotes"
        label={t("creator_notes")}
        mobileExpandLabel={t("creator_notes_label")}
        minHeight={60}
        placeholder={t("creator_notes_placeholder")}
        isSaving={isSaving}
      />

      {/* Depth Prompt */}
      <DepthPromptField form={form} isSaving={isSaving} />

      {/* System Prompt Override */}
      <TextAreaField
        form={form}
        field="systemPrompt"
        label={t("system_prompt_override")}
        mobileExpandLabel={t("system_prompt_label")}
        minHeight={80}
        mono
        placeholder={t("system_prompt_override_placeholder")}
        isSaving={isSaving}
      />

      {/* Footer */}
      <div className={cn("mt-2 flex flex-wrap items-center gap-2", isMobile && "pb-8")}>
        <button type="button" className={cn("cursor-pointer rounded-md bg-transparent px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1", isMobile && "min-h-[44px]")} disabled={isSaving || !isDirty} onClick={onReset}>{t("reset")}</button>
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{isDirty ? t("unsaved_changes") : t("saved_state")}</span>
      </div>

      {importModalOpen && (
        <CharacterImportModal
          isImporting={false}
          onClose={() => setImportModalOpen(false)}
          onImportFiles={handleImportFiles}
        />
      )}

      <AiAssistantModal
        mode="full"
        isOpen={mdImportOpen}
        onClose={() => setMdImportOpen(false)}
        apiMode="md_import"
        onMdImportApply={handleMdImportApply}
      />
      {pendingAvatar && (
        <AvatarCropModal
          imageUrl={pendingAvatar.url}
          onConfirm={handleAvatarCropConfirm}
          onCancel={handleAvatarCropCancel}
        />
      )}
    </div>
  );
}
