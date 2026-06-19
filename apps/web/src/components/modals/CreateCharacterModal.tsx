import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Ic } from '../shared/icons';
import { cn } from '../../lib/cn';
import { Modal } from "../shared/Modal.js";
import { useIsMobile } from '../../hooks/use-mobile.js';
import { CustomTooltip } from '../shared/Tooltip.js';
import { useT } from '../../i18n/context.js';
import { DropdownSelect } from '../shared/DropdownSelect.js';
import { AutoTextarea } from '../shared/auto-textarea.js';
import { MobileExpandTextarea } from '../shared/MobileExpandTextarea.js';
import { NumberInput } from '../shared/NumberInput.js';
import { AvatarCropModal } from '../shared/AvatarCropModal.js';
import type { AvatarCropResult } from '../shared/AvatarCropModal.js';

const createCharacterFormSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  firstMessage: z.string(),
  mesExample: z.string(),
  defaultScenario: z.string(),
  personalitySummary: z.string(),
  alternateGreetings: z.array(z.string()),
  postHistoryInstructions: z.string(),
  creatorNotes: z.string(),
  systemPrompt: z.string(),
  depthPrompt: z.string(),
  depthPromptDepth: z.number(),
  depthPromptRole: z.string(),
  tags: z.array(z.string()),
  avatarFile: z.unknown().nullable().optional(),
  avatarOriginalFile: z.unknown().nullable().optional(),
  avatarPreview: z.string().nullable().optional(),
});

type CreateCharacterFormData = z.infer<typeof createCharacterFormSchema>;

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
  const form = useForm<CreateCharacterFormData>({
    resolver: zodResolver(createCharacterFormSchema),
    defaultValues: {
      name: '',
      description: '',
      personalitySummary: '',
      mesExample: '',
      defaultScenario: '',
      firstMessage: '',
      alternateGreetings: [],
      postHistoryInstructions: '',
      creatorNotes: '',
      systemPrompt: '',
      tags: [],
      avatarFile: null,
      avatarOriginalFile: null,
      avatarPreview: null,
      depthPrompt: '',
      depthPromptDepth: 4,
      depthPromptRole: 'system',
    },
  });

  const { register, formState: { errors, isSubmitting, isDirty }, watch, setValue, handleSubmit } = form;
  const busy = isSubmitting;
  const dirty = isDirty;

  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState('');
  const avaInputRef = useRef<HTMLInputElement>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);



  const name = watch('name');
  const description = watch('description');
  const firstMessage = watch('firstMessage');
  const mesExample = watch('mesExample');
  const defaultScenario = watch('defaultScenario');
  const personalitySummary = watch('personalitySummary');
  const alternateGreetings = watch('alternateGreetings') || [];
  const postHistoryInstructions = watch('postHistoryInstructions');
  const creatorNotes = watch('creatorNotes');
  const systemPrompt = watch('systemPrompt');
  const depthPrompt = watch('depthPrompt');
  const depthPromptDepth = watch('depthPromptDepth');
  const depthPromptRole = watch('depthPromptRole');
  const tags = watch('tags') || [];
  const avatarPreview = watch('avatarPreview') as string | null;
  const avatarFile = watch('avatarFile') as File | null;
  const avatarOriginalFile = watch('avatarOriginalFile') as File | null;

  const canSave = (name || '').trim().length > 0 && !busy;

  function patchForm(patch: Partial<CreateCharacterFormData>) {
    for (const [key, value] of Object.entries(patch)) {
      setValue(key as keyof CreateCharacterFormData, value, { shouldDirty: true });
    }
  }

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setPendingAvatar({ file, url: URL.createObjectURL(file) });
  }

  function handleAvatarCropConfirm(result: AvatarCropResult) {
    patchForm({
      avatarFile: result.croppedFile,
      avatarOriginalFile: pendingAvatar!.file,
      avatarPreview: pendingAvatar!.url,
    });
    setPendingAvatar(null);
  }

  function handleAvatarCropCancel() {
    if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    setPendingAvatar(null);
  }

  function removeTag(tag: string) {
    patchForm({ tags: tags.filter((t: string) => t !== tag) });
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
    if (!canSave) return;
    await onSave(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        firstMessage: firstMessage.trim() || undefined,
        scenario: defaultScenario.trim() || undefined,
        personalitySummary: personalitySummary.trim() || undefined,
        mesExample: mesExample.trim() || undefined,
        alternateGreetings: alternateGreetings.length > 0 ? alternateGreetings : undefined,
        postHistoryInstructions: postHistoryInstructions.trim() || undefined,
        creatorNotes: creatorNotes.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        depthPrompt: depthPrompt.trim() || undefined,
        depthPromptDepth: depthPromptDepth || undefined,
        depthPromptRole: depthPromptRole || undefined,
        tags: tags.length > 0 ? tags : undefined,
      },
      avatarFile,
      avatarOriginalFile,
    );
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
              {avatarPreview ? (
                <>
                  <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
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
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_desc_label")}</label>
            <MobileExpandTextarea label={t("char_desc_label")} value={description || ''} onChange={v => setValue('description', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[100px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                style={{}}
                maxHeight={400}
                register={register('description')}
              />
            </MobileExpandTextarea>
          </div>

          {/* First Message */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ws_first_msg_label")}</label>
            <MobileExpandTextarea label={t("ws_first_msg_label")} value={firstMessage || ''} onChange={v => setValue('firstMessage', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                style={{}}
                maxHeight={400}
                placeholder={t("first_message_placeholder")}
                register={register('firstMessage')}
              />
            </MobileExpandTextarea>
          </div>

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
                  className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                  style={{}}
                  maxHeight={400}
                  value={alternateGreetings[altGreetIdx] || ''}
                  onChange={e => {
                    const next = [...alternateGreetings];
                    next[altGreetIdx] = e.target.value;
                    setValue('alternateGreetings', next, { shouldDirty: true });
                  }}
                  placeholder={t("alternate_greeting_placeholder")}
                />
              </MobileExpandTextarea>
            )}
          </div>

          {/* Mes Example */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("dialog_examples")}</label>
            <MobileExpandTextarea label={t("dialog_examples")} value={mesExample || ''} onChange={v => setValue('mesExample', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
                style={{}}
                maxHeight={400}
                register={register('mesExample')}
                placeholder={t("dialog_examples_placeholder")}
              />
            </MobileExpandTextarea>
          </div>

          {/* Scenario */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("scenario")}</label>
            <MobileExpandTextarea label={t("scenario")} value={defaultScenario || ''} onChange={v => setValue('defaultScenario', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[100px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                style={{}}
                maxHeight={400}
                register={register('defaultScenario')}
              />
            </MobileExpandTextarea>
          </div>

          {/* Personality */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_personality_label")}</label>
            <MobileExpandTextarea label={t("char_personality_label")} value={personalitySummary || ''} onChange={v => setValue('personalitySummary', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                style={{}}
                maxHeight={400}
                register={register('personalitySummary')}
              />
            </MobileExpandTextarea>
          </div>

          {/* Advanced separator */}
          <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3 mt-6 mb-3 pb-1.5">{t("advanced_fields_v3")}</div>

          {/* Post History Instructions */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("post_history_instructions")}</label>
            <MobileExpandTextarea label={t("post_history_instructions")} value={postHistoryInstructions || ''} onChange={v => setValue('postHistoryInstructions', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
                style={{}}
                maxHeight={400}
                register={register('postHistoryInstructions')}
                placeholder={t("post_history_placeholder")}
              />
            </MobileExpandTextarea>
          </div>

          {/* Creator Notes */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("creator_notes")}</label>
            <MobileExpandTextarea label={t("creator_notes")} value={creatorNotes || ''} onChange={v => setValue('creatorNotes', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-body text-t1 outline-none focus:border-accent"
                style={{}}
                maxHeight={400}
                register={register('creatorNotes')}
                placeholder={t("creator_notes_placeholder")}
              />
            </MobileExpandTextarea>
          </div>

          {/* Depth Prompt */}
          <div className="mb-5">
            <div className="mb-1.5 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
              <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("depth_prompt")}</label>
              <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-4">
                <div className="flex items-center gap-2">
                  <span className="font-ui text-[11px] font-medium uppercase tracking-wider text-t3">{t("role")}</span>
                  <DropdownSelect
                    className="w-[120px]"
                    searchable={false}
                    value={depthPromptRole}
                    options={[
                      { id: "system", label: "system" },
                      { id: "user", label: "user" },
                      { id: "assistant", label: "assistant" },
                    ]}
                    onChange={v => setValue('depthPromptRole', v, { shouldDirty: true })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-ui text-[11px] font-medium uppercase tracking-wider text-t3">{t("depth")}</span>
                  <NumberInput
                    className="w-[90px]"
                    min={0}
                    max={999}
                    value={depthPromptDepth}
                    onChange={v => setValue('depthPromptDepth', v, { shouldDirty: true })}
                  />
                </div>
              </div>
            </div>
            <MobileExpandTextarea label={t("depth_prompt")} value={depthPrompt || ''} onChange={v => setValue('depthPrompt', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
                style={{}}
                maxHeight={400}
                register={register('depthPrompt')}
                placeholder={t("depth_prompt_placeholder")}
              />
            </MobileExpandTextarea>
          </div>

          {/* System Prompt Override */}
          <div className="mb-5">
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("system_prompt_override")}</label>
            <MobileExpandTextarea label={t("system_prompt_override")} value={systemPrompt || ''} onChange={v => setValue('systemPrompt', v, { shouldDirty: true })}>
              <AutoTextarea
                className="w-full min-h-[80px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
                style={{}}
                maxHeight={400}
                register={register('systemPrompt')}
                placeholder={t("system_prompt_override_placeholder")}
              />
            </MobileExpandTextarea>
          </div>

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
