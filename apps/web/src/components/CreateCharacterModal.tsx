import { useRef, useState } from 'react';
import { Ic } from './shared/icons';
import { cn } from '../lib/cn';
import { useT } from '../i18n/context.js';

interface CreateCharacterForm {
  name: string;
  description: string;
  firstMessage: string;
  mesExample: string;
  defaultScenario: string;
  personalitySummary: string;
  alternateGreetings: string[];
  postHistoryInstructions: string;
  creatorNotes: string;
  systemPrompt: string;
  characterBook: string;
  depthPrompt: string;
  depthPromptDepth: number;
  depthPromptRole: string;
  extensions: string;
  tags: string[];
  avatarFile: File | null;
  avatarPreview: string | null;
}

interface CreateCharacterModalProps {
  onClose: () => void;
  onSave: (data: {
    name: string;
    description?: string;
    firstMessage?: string;
    scenario?: string;
    personalitySummary?: string;
  }, avatarFile: File | null) => Promise<{ characterId: string; chatId: string } | null>;
}

export function CreateCharacterModal({ onClose, onSave }: CreateCharacterModalProps) {
  const { t } = useT();
  const [form, setForm] = useState<CreateCharacterForm>({
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
    avatarPreview: null,
    characterBook: '',
    depthPrompt: '',
    depthPromptDepth: 4,
    depthPromptRole: 'system',
    extensions: '',
  });

  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState('');
  const avaInputRef = useRef<HTMLInputElement>(null);

  const canSave = form.name.trim().length > 0 && !busy;

  function patchForm(patch: Partial<CreateCharacterForm>) {
    setForm(prev => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    patchForm({
      avatarFile: file,
      avatarPreview: URL.createObjectURL(file),
    });
  }

  function removeTag(t: string) {
    patchForm({ tags: form.tags.filter(tag => tag !== t) });
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!form.tags.includes(tagInput.trim())) {
        patchForm({ tags: [...form.tags, tagInput.trim()] });
      }
      setTagInput('');
    }
  }

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave(
        {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          firstMessage: form.firstMessage.trim() || undefined,
          scenario: form.defaultScenario.trim() || undefined,
          personalitySummary: form.personalitySummary.trim() || undefined,
        },
        form.avatarFile,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[90vh] w-[600px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        {/* Header */}
        <div className="shrink-0 border-b border-border" style={{padding:'18px 20px 16px'}}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
                {t("create_character_manual")}
                {dirty && <span className="dirty-dot" title={t("unsaved_changes_title")} />}
              </div>
            </div>
            <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
              {Ic.close()}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{padding:20}}>
          {/* Avatar + Name row */}
          <div className="flex gap-4" style={{marginBottom:20}}>
            <div
              className="group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
              onClick={() => avaInputRef.current?.click()}
              title={t("upload_avatar")}
            >
              <input
                ref={avaInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                onChange={e => handleAvatarPick(e.target.files)}
              />
              {form.avatarPreview ? (
                <>
                  <img src={form.avatarPreview} alt="" className="h-full w-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">{Ic.edit()}</div>
                </>
              ) : (
                Ic.plus()
              )}
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ws_name_label")}</label>
              <input
                type="text"
                className="w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
                style={{padding:'6px 10px'}}
                value={form.name}
                onChange={e => patchForm({ name: e.target.value })}
                autoFocus
              />
            </div>
          </div>

          {/* Description */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_desc_label")}</label>
            <textarea
              className="w-full min-h-[100px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={form.description}
              onChange={e => patchForm({ description: e.target.value })}
            />
          </div>

          {/* First Message */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ws_first_msg_label")}</label>
            <textarea
              className="w-full min-h-[120px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={form.firstMessage}
              onChange={e => patchForm({ firstMessage: e.target.value })}
              placeholder={t("first_message_placeholder")}
            />
          </div>

          {/* Alternate Greetings */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("alternate_greetings")}</label>
            <div className="flex flex-wrap gap-1" style={{marginBottom:8}}>
              {form.alternateGreetings.map((_, idx) => (
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
                    const next = [...form.alternateGreetings];
                    next.splice(idx, 1);
                    patchForm({ alternateGreetings: next });
                    if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
                  }}>✕</span>
                </span>
              ))}
              <span
                className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent px-2.5 py-0.5 font-ui text-xs text-t3 cursor-pointer"
                onClick={() => {
                  const next = [...form.alternateGreetings, ''];
                  patchForm({ alternateGreetings: next });
                  setAltGreetIdx(next.length - 1);
                }}
              >+</span>
            </div>
            {form.alternateGreetings.length > 0 && (
              <textarea
                className="w-full min-h-[120px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
                style={{padding:'6px 10px'}}
                value={form.alternateGreetings[altGreetIdx] || ''}
                onChange={e => {
                  const next = [...form.alternateGreetings];
                  next[altGreetIdx] = e.target.value;
                  patchForm({ alternateGreetings: next });
                }}
                placeholder={t("alternate_greeting_placeholder")}
              />
            )}
          </div>

          {/* Mes Example */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("dialog_examples")}</label>
            <textarea
              className="w-full min-h-[120px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
              style={{padding:'6px 10px'}}
              value={form.mesExample}
              onChange={e => patchForm({ mesExample: e.target.value })}
              placeholder={t("dialog_examples_placeholder")}
            />
          </div>

          {/* Scenario */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("scenario")}</label>
            <textarea
              className="w-full min-h-[100px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={form.defaultScenario}
              onChange={e => patchForm({ defaultScenario: e.target.value })}
            />
          </div>

          {/* Personality */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_personality_label")}</label>
            <textarea
              className="w-full min-h-[60px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={form.personalitySummary}
              onChange={e => patchForm({ personalitySummary: e.target.value })}
            />
          </div>

          {/* Advanced separator */}
          <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3" style={{marginTop:24, marginBottom:12, paddingBottom:6}}>{t("advanced_fields_v3")}</div>

          {/* Post History Instructions */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("post_history_instructions")}</label>
            <textarea
              className="w-full min-h-[60px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
              style={{padding:'6px 10px'}}
              value={form.postHistoryInstructions}
              onChange={e => patchForm({ postHistoryInstructions: e.target.value })}
              placeholder={t("post_history_placeholder")}
            />
          </div>

          {/* Creator Notes */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("creator_notes")}</label>
            <textarea
              className="w-full min-h-[60px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={form.creatorNotes}
              onChange={e => patchForm({ creatorNotes: e.target.value })}
              placeholder={t("creator_notes_placeholder")}
            />
          </div>

          {/* Character Book JSON */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("character_book_json")}</label>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
              style={{padding:'6px 10px'}}
              value={form.characterBook}
              onChange={e => patchForm({ characterBook: e.target.value })}
              placeholder='{"entries":[...]}'
            />
          </div>

          {/* Depth Prompt row */}
          <div className="flex gap-3 items-end">
            <div style={{marginBottom:20}} className="flex-1">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("depth_prompt")}</label>
              <textarea
                className="w-full min-h-[60px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
                style={{padding:'6px 10px'}}
                value={form.depthPrompt}
                onChange={e => patchForm({ depthPrompt: e.target.value })}
                placeholder={t("depth_prompt_placeholder")}
              />
            </div>
            <div style={{marginBottom:20}} className="w-20 shrink-0">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("depth")}</label>
              <input
                type="number"
                className="w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
                style={{padding:'6px 10px'}}
                min={0}
                max={999}
                value={form.depthPromptDepth}
                onChange={e => patchForm({ depthPromptDepth: Number(e.target.value) })}
              />
            </div>
            <div style={{marginBottom:20}} className="w-[110px] shrink-0">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("role")}</label>
              <select
                className="w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
                style={{padding:'6px 10px'}}
                value={form.depthPromptRole}
                onChange={e => patchForm({ depthPromptRole: e.target.value })}
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </div>
          </div>

          {/* Extensions JSON */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("extensions_json")}</label>
            <textarea
              className="w-full min-h-[60px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
              style={{padding:'6px 10px'}}
              value={form.extensions}
              onChange={e => patchForm({ extensions: e.target.value })}
              placeholder='{"talkativeness":"0.5",...}'
            />
          </div>

          {/* System Prompt Override */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("system_prompt_override")}</label>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
              style={{padding:'6px 10px'}}
              value={form.systemPrompt}
              onChange={e => patchForm({ systemPrompt: e.target.value })}
              placeholder={t("system_prompt_override_placeholder")}
            />
          </div>

          {/* Tags */}
          <div style={{marginBottom:20}}>
            <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("char_tags_label")}</label>
            <input
              type="text"
              className="w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent"
              style={{padding:'6px 10px'}}
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKey}
              placeholder={t("tags_enter")}
            />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {form.tags.map(tag => (
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
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border" style={{padding:'14px 20px'}}>
          <button
            className="ml-auto cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            style={{height:37, padding:'0 16px'}}
            onClick={onClose}
            disabled={busy}
          >{t("cancel")}</button>
          <button
            className="cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
            style={{height:37, padding:'0 18px'}}
            disabled={!canSave}
            onClick={handleSave}
          >
            {busy ? t("ws_creating") : t("ws_create_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}
