import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { buildCharacterDraftSchema } from '@vibe-tavern/api-contracts';
import type { BuildCharacterDraft } from '@vibe-tavern/api-contracts';
import { Ic } from '../shared/icons';
import { cn } from '../../lib/cn';
import { Modal } from "../shared/Modal.js";
import { useIsMobile } from '../../hooks/use-mobile.js';
import { CustomTooltip } from '../shared/Tooltip.js';
import { useT } from '../../i18n/context.js';
import { AutoTextarea } from '../shared/auto-textarea.js';
import { MobileExpandTextarea } from '../shared/MobileExpandTextarea.js';
import { AvatarCropModal } from '../shared/AvatarCropModal.js';
import type { AvatarCropResult } from '../shared/AvatarCropModal.js';
import { TextAreaField } from '../build/fields/TextAreaField.js';
import { DepthPromptField } from '../build/fields/DepthPromptField.js';
import { TokenCounter } from '../shared/TokenCounter.js';
import { EMPTY_BUILD_DRAFT } from '../../lib/character-draft.js';

interface CreateCharacterModalProps {
  onClose: () => void;
  onSave: (data: {
    name: string;
    description?: string;
    firstMessage?: string;
    scenario?: string;
    personalitySummary?: string;
    mesExample?: string;
    alternateGreetings?: string[];
    postHistoryInstructions?: string;
    creatorNotes?: string;
    systemPrompt?: string;
    depthPrompt?: string;
    depthPromptDepth?: number;
    depthPromptRole?: string;
    tags?: string[];
  }, avatarFile: File | null, avatarOriginalFile: File | null) => Promise<{ characterId: string; chatId: string } | null>;
}

export function CreateCharacterModal({ onClose, onSave }: CreateCharacterModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const form = useForm<BuildCharacterDraft>({
    resolver: zodResolver(buildCharacterDraftSchema),
    defaultValues: EMPTY_BUILD_DRAFT,
  });

  const { register, formState: { errors, isDirty }, watch, setValue, getValues } = form;
  // `isSubmitting` never flips here — the save button is type="button" (no native
  // form submit) — so a local submitting flag + re-entry ref drive the in-flight
  // UI and prevent a double-click from firing two creates.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const busy = submitting;
  const name = watch("name");
  const alternateGreetings = watch("alternateGreetings") || [];
  const tags = watch("tags") || [];

  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState('');
  const avaInputRef = useRef<HTMLInputElement>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);
  // Confirmed (post-crop) avatar lives outside the form: BuildCharacterDraft has
  // no avatar fields (it is a content draft), and the create flow handles raw
  // File uploads rather than the asset-id model the build editor uses.
  const [avatar, setAvatar] = useState<{ file: File | null; originalFile: File | null; preview: string | null }>({
    file: null,
    originalFile: null,
    preview: null,
  });

  // A picked avatar counts as an unsaved change even though it is not in the
  // react-hook-form state, so it is folded into the dirty flag manually.
  const dirty = isDirty || avatar.file !== null;
  const canSave = (name || '').trim().length > 0 && !busy;

  function patchForm(patch: Partial<BuildCharacterDraft>) {
    for (const [key, value] of Object.entries(patch)) {
      setValue(key as keyof BuildCharacterDraft, value, { shouldDirty: true });
    }
  }

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setPendingAvatar({ file, url: URL.createObjectURL(file) });
  }

  function handleAvatarCropConfirm(result: AvatarCropResult) {
    setAvatar({
      file: result.croppedFile,
      originalFile: pendingAvatar!.file,
      preview: pendingAvatar!.url,
    });
    setPendingAvatar(null);
  }

  function handleAvatarCropCancel() {
    if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    setPendingAvatar(null);
  }

  function removeTag(tag: string) {
    patchForm({ tags: tags.filter((tn: string) => tn !== tag) });
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!tags.includes(tagInput.trim())) {
        patchForm({ tags: [...tags, tagInput.trim()] });
      }
      setTagInput('');
    }
  }

  async function handleSave() {
    if (!canSave || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const v = getValues();
    await onSave(
      {
        name: v.name.trim(),
        description: v.description.trim() || undefined,
        firstMessage: v.firstMessage.trim() || undefined,
        scenario: v.scenario.trim() || undefined,
        personalitySummary: v.personalitySummary.trim() || undefined,
        mesExample: v.mesExample.trim() || undefined,
        alternateGreetings: v.alternateGreetings.length > 0 ? v.alternateGreetings : undefined,
        postHistoryInstructions: v.postHistoryInstructions.trim() || undefined,
        creatorNotes: v.creatorNotes.trim() || undefined,
        systemPrompt: v.systemPrompt.trim() || undefined,
        depthPrompt: v.depthPrompt.trim() || undefined,
        depthPromptDepth: v.depthPromptDepth || undefined,
        depthPromptRole: v.depthPromptRole || undefined,
        tags: v.tags.length > 0 ? v.tags : undefined,
      },
      avatar.file,
      avatar.originalFile,
    ).finally(() => {
      submittingRef.current = false;
      setSubmitting(false);
    });
  }

  return (
    <Modal open={true} onClose={onClose}>

      <div className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "max-h-[90vh] w-[600px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}>
        {/* Header */}
        <div className={cn("shrink-0 border-b border-border", isMobile ? "px-4 pt-4 pb-3" : "px-5 pt-[18px] pb-4")}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
                {t("create_character_manual")}
                {dirty && <CustomTooltip content={t("unsaved_changes_title")}><span className="dirty-dot" /></CustomTooltip>}
              </div>
            </div>
            <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
              {Ic.close()}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className={cn("flex-1 overflow-y-auto", isMobile ? "p-4" : "p-5")}>
          {/* Avatar + Name row */}
          <div className={cn("flex gap-4 mb-5", isMobile && "flex-col items-center")}>
            <CustomTooltip content={t("upload_avatar")}>
            <div
              className="group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
              onClick={() => avaInputRef.current?.click()}
            >
              <input
                ref={avaInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                onChange={e => handleAvatarPick(e.target.files)}
              />
              {avatar.preview ? (
                <>
                  <img src={avatar.preview} alt="" className="h-full w-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">{Ic.edit()}</div>
                </>
              ) : (
                Ic.plus()
              )}
            </div>
            </CustomTooltip>
            {pendingAvatar && (
              <AvatarCropModal
                imageUrl={pendingAvatar.url}
                onConfirm={handleAvatarCropConfirm}
                onCancel={handleAvatarCropCancel}
              />
            )}
            <div className="flex-1">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ws_name_label")}</label>
              <input
                type="text"
                className={cn("w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent", isMobile && "text-base min-h-[44px]")}
                {...register('name')}
                autoFocus
              />
              {errors.name && (
                <div className="text-[11px] text-danger-text mt-0.5">{errors.name.message}</div>
              )}
            </div>
          </div>

          {/* Description */}
          <TextAreaField
            form={form}
            field="description"
            label={t("char_desc_label")}
            mobileExpandLabel={t("char_desc_label")}
            minRows={5}
            maxRows={20}
            isSaving={busy}
          />

          {/* First Message */}
          <TextAreaField
            form={form}
            field="firstMessage"
            label={t("ws_first_msg_label")}
            mobileExpandLabel={t("ws_first_msg_label")}
            minRows={6}
            maxRows={20}
            placeholder={t("first_message_placeholder")}
            isSaving={busy}
          />

          {/* Alternate Greetings */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("alternate_greetings")}</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {alternateGreetings.map((_: string, idx: number) => (
                <span
                  key={idx}
                  className={cn(
                    "inline-flex items-center gap-1 rounded border border-border bg-s2 px-2.5 py-0.5 font-ui text-xs text-t2 cursor-pointer transition-all",
                    idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t"
                  )}
                  onClick={() => setAltGreetIdx(idx)}
                >
                  Alt {idx + 1}
                  <span className="ml-0.5 cursor-pointer text-[10px]" onClick={e => {
                    e.stopPropagation();
                    const next = [...alternateGreetings];
                    next.splice(idx, 1);
                    setValue('alternateGreetings', next, { shouldDirty: true });
                    if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
                  }}>✕</span>
                </span>
              ))}
              <span
                className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent px-2.5 py-0.5 font-ui text-xs text-t3 cursor-pointer"
                onClick={() => {
                  const next = [...alternateGreetings, ''];
                  setValue('alternateGreetings', next, { shouldDirty: true });
                  setAltGreetIdx(next.length - 1);
                }}
              >+</span>
            </div>
            {alternateGreetings.length > 0 && (
              <>
                <MobileExpandTextarea
                  label={t("alternate_greetings")}
                  value={alternateGreetings[altGreetIdx] || ''}
                  onChange={v => {
                    const next = [...alternateGreetings];
                    next[altGreetIdx] = v;
                    setValue('alternateGreetings', next, { shouldDirty: true });
                  }}
                >
                  <AutoTextarea
                    className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                    style={{}}
                    maxRows={20}
                    minRows={6}
                    value={alternateGreetings[altGreetIdx] || ''}
                    onChange={e => {
                      const next = [...alternateGreetings];
                      next[altGreetIdx] = e.target.value;
                      setValue('alternateGreetings', next, { shouldDirty: true });
                    }}
                    placeholder={t("alternate_greeting_placeholder")}
                  />
                </MobileExpandTextarea>
                <TokenCounter text={alternateGreetings[altGreetIdx] || ""} />
              </>
            )}
          </div>

          {/* Mes Example */}
          <TextAreaField
            form={form}
            field="mesExample"
            label={t("dialog_examples")}
            mobileExpandLabel={t("dialog_examples")}
            minRows={6}
            maxRows={20}
            mono
            placeholder={t("dialog_examples_placeholder")}
            isSaving={busy}
          />

          {/* Scenario */}
          <TextAreaField
            form={form}
            field="scenario"
            label={t("scenario")}
            mobileExpandLabel={t("scenario")}
            minRows={5}
            maxRows={20}
            isSaving={busy}
          />

          {/* Personality */}
          <TextAreaField
            form={form}
            field="personalitySummary"
            label={t("char_personality_label")}
            mobileExpandLabel={t("char_personality_label")}
            minRows={3}
            maxRows={20}
            isSaving={busy}
          />

          {/* Advanced separator */}
          <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3 mt-6 mb-3 pb-1.5">{t("advanced_fields_v3")}</div>

          {/* Post History Instructions */}
          <TextAreaField
            form={form}
            field="postHistoryInstructions"
            label={t("post_history_instructions")}
            mobileExpandLabel={t("post_history_instructions")}
            minRows={3}
            maxRows={20}
            mono
            placeholder={t("post_history_placeholder")}
            isSaving={busy}
          />

          {/* Creator Notes */}
          <TextAreaField
            form={form}
            field="creatorNotes"
            label={t("creator_notes")}
            mobileExpandLabel={t("creator_notes")}
            minRows={3}
            maxRows={20}
            placeholder={t("creator_notes_placeholder")}
            isSaving={busy}
          />

          {/* Depth Prompt */}
          <DepthPromptField form={form} isSaving={busy} />

          {/* System Prompt Override */}
          <TextAreaField
            form={form}
            field="systemPrompt"
            label={t("system_prompt_override")}
            mobileExpandLabel={t("system_prompt_override")}
            minRows={4}
            maxRows={20}
            mono
            placeholder={t("system_prompt_override_placeholder")}
            isSaving={busy}
          />

          {/* Tags */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_tags_label")}</label>
            <input
              type="text"
              className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKey}
              placeholder={t("tags_enter")}
            />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {tags.map((tag: string) => (
                <span
                  key={tag}
                  className="cursor-pointer rounded bg-accent-dim px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => removeTag(tag)}
                >{tag} ✕</span>
              ))}
            </div>
          </div>

          {/* TODO: Phase 3 — Capabilities (built-in tools + MCP tools) */}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-[14px]">
          <button type="button"
            className="ml-auto h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            onClick={onClose}
            disabled={busy}
          >{t("cancel")}</button>
          <button type="button"
            className="h-[37px] px-[18px] cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
            disabled={!canSave}
            onClick={handleSave}
          >
            {busy ? t("ws_creating") : t("ws_create_btn")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
