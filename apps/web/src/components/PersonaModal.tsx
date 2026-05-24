import { useState, useRef } from "react";
import { useForm } from "react-hook-form";
// No zodResolver — form has extra UI fields (pronounsCustom, avatarPreview) not in the schema.
// Validation is handled manually (name.trim() check).
import { Icons } from "./shared/icons.js";
import { EmptyState } from "./shared/empty-state.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { AvatarCropModal } from "./shared/AvatarCropModal.js";
import type { AvatarCropResult } from "./shared/AvatarCropModal.js";
import { cn } from "../lib/cn.js";
import { AutoTextarea } from "./shared/auto-textarea.js";
import { Modal } from "./shared/Modal.js";
import { avatarUrl } from "../lib/avatar.js";
import { uploadAsset } from "../app-client.js";
import { useTokenCount } from "../hooks/use-token-count.js";
import { useT } from "../i18n/context.js";
import { useModalStore } from "../stores/modal-store.js";

interface PersonaListItem {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
}

interface PersonaModalProps {
  personas: PersonaListItem[];
  activePersonaId: string | null;
  isSaving: boolean;
  onSaveEdit: (personaId: string, draft: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null; avatarFullAssetId?: string | null }) => void;
  onSetActive: (personaId: string) => void;
  onCreatePersona: (input: { name: string; description: string; pronouns?: string | null }) => Promise<{ id: string } | null>;
  onDuplicatePersona: (personaId: string) => Promise<void>;
  onDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
}

type PersonaFormData = {
  name: string;
  description: string;
  pronouns: string | null;
  pronounsCustom: string;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarPreview: string | null;
};

function PersonaTokenBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  return <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3 mb-3">{count.toLocaleString()} tokens</span>;
}

function PersonaPreviewBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  return <span className="font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} tokens</span>;
}

export function PersonaModal(input: PersonaModalProps) {
  const { t } = useT();
  const isOpen = useModalStore((s) => s.isPersonaModalOpen);
  const setIsOpen = useModalStore((s) => s.setIsPersonaModalOpen);
  const onClose = () => setIsOpen(false);
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; error: string } | null>(null);

  // ── Avatar crop modal state ──
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);

  const form = useForm<PersonaFormData>({
    defaultValues: {
      name: "",
      description: "",
      pronouns: null,
      pronounsCustom: "",
      avatarAssetId: null,
      avatarFullAssetId: null,
      avatarPreview: null,
    },
  });

  if (!isOpen) return null;

  const isEditing = editingId !== null;
  const isLastPersona = input.personas.length <= 1;

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    form.reset({
      name: persona.name,
      description: persona.description,
      pronouns: persona.pronouns ?? "",
      pronounsCustom: "",
      avatarAssetId: persona.avatarAssetId,
      avatarFullAssetId: null,
      avatarPreview: null,
    });
  }

  function commitEdit(): void {
    if (!editingId) return;
    const name = form.getValues("name");
    const description = form.getValues("description");
    const pronouns = form.getValues("pronouns");
    const pronounsCustom = form.getValues("pronounsCustom");
    const avatarAssetId = form.getValues("avatarAssetId");
    const avatarFullAssetId = form.getValues("avatarFullAssetId");
    if (!name.trim()) return;
    const resolved = pronouns === "custom"
      ? (pronounsCustom.trim() || null)
      : (pronouns || null);
    input.onSaveEdit(editingId, { name: name.trim(), description, pronouns: resolved, avatarAssetId, avatarFullAssetId });
    setSelectedId(editingId);
    setEditingId(null);
  }

  function cancelEdit(): void {
    setEditingId(null);
  }

  function setActiveAndClose(): void {
    const persona = input.personas.find((p) => p.id === selectedId) || input.personas[0];
    if (persona) input.onSetActive(persona.id);
    onClose();
  }

  function handleAvatarCropConfirm(result: AvatarCropResult): void {
    // Show cropped preview immediately
    form.setValue("avatarPreview", result.croppedUrl);
    // Upload both the cropped and original files in parallel
    setAvatarUploading(true);
    Promise.all([
      uploadAsset(result.croppedFile),
      uploadAsset(pendingAvatar!.file),
    ])
      .then(([croppedRes, originalRes]) => {
        form.setValue("avatarAssetId", croppedRes.assetId, { shouldDirty: true });
        form.setValue("avatarFullAssetId", originalRes.assetId, { shouldDirty: true });
      })
      .catch(() => {
        form.setValue("avatarPreview", null);
        form.setValue("avatarAssetId", null);
        form.setValue("avatarFullAssetId", null);
      })
      .finally(() => {
        setAvatarUploading(false);
        setPendingAvatar(null);
      });
  }

  function handleAvatarCropCancel(): void {
    if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    setPendingAvatar(null);
  }

  function handleDelete(personaId: string): void {
    if (isLastPersona) {
      setDeleteConfirm({ id: personaId, error: t("cannot_delete_last_persona") });
      return;
    }
    setDeleteConfirm({ id: personaId, error: "" });
  }

  function resolvePronounsDisplay(persona: PersonaListItem): string | null {
    if (!persona.pronouns) return null;
    return persona.pronouns;
  }

  const editName = form.watch("name");
  const editDescription = form.watch("description");
  const editPronouns = form.watch("pronouns");
  const editPronounsCustom = form.watch("pronounsCustom");
  const editAvatarAssetId = form.watch("avatarAssetId");
  const editAvatarPreview = form.watch("avatarPreview");
  const { errors } = form.formState;

  return (
    <Modal open={true} onClose={onClose}>
      {/* Avatar crop modal */}
      {pendingAvatar && (
        <AvatarCropModal
          imageUrl={pendingAvatar.url}
          originalFile={pendingAvatar.file}
          onConfirm={handleAvatarCropConfirm}
          onCancel={handleAvatarCropCancel}
        />
      )}
      {deleteConfirm && (
        <DestructiveConfirmModal
          title={t("delete_persona_title")}
          body={
            <>
              {t("delete_persona_body").replace("{name}", input.personas.find((p) => p.id === deleteConfirm.id)?.name ?? "Untitled")}
              {deleteConfirm.error && <div className="mt-2 text-[oklch(0.6_0.15_25)]">{deleteConfirm.error}</div>}
            </>
          }
          confirmLabel={t("delete")}
          onConfirm={async () => {
            const id = deleteConfirm.id;
            const result = await input.onDeletePersona(id);
            if (result.ok) {
              setDeleteConfirm(null);
              if (selectedId === id) setSelectedId(null);
            } else {
              setDeleteConfirm({ id, error: result.error ?? t("delete_failed") });
            }
          }}
          onCancel={() => {
            setDeleteConfirm(null);
          }}
        />
      )}
      <div
        className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[500px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px]">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-body mb-0.5 text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("persona_manager_title")}</div>
              <div className="font-ui mb-3.5 text-[calc(var(--ui-fs)-2px)] text-t3">{t("persona_manager_sub")}</div>
            </div>
            <div className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
              <Icons.Close />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-col gap-2">
            {input.personas.length === 0 && (
              <EmptyState
                icon={<Icons.User />}
                title={t("no_personas")}
                sub={t("create_first_persona")}
              />
            )}
            {input.personas.map((persona) => {
              const isSelected = selectedId === persona.id;
              const editingThis = editingId === persona.id;
              return (
                <div
                  key={persona.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-all hover:bg-s2 hover:border-border2",
                    isSelected ? "border-accent bg-accent-dim" : "border-border"
                  )}
                  onClick={() => !isEditing && setSelectedId(persona.id)}
                >
                  {editingThis ? (
                    /* ── Editing state ── */
                    <div className="w-full" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-3 mb-3">
                        {/* AvatarPicker */}
                        {/* AvatarPicker — outer wrapper carries 'group' so remove button is visible */}
                        <div className="group relative shrink-0">
                          <div
                            className={cn(
                              "relative flex h-16 w-16 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent hover:text-accent-t",
                              avatarUploading && "pointer-events-none opacity-60"
                            )}
                            onClick={() => !avatarUploading && avatarInputRef.current?.click()}
                            title={t("upload_avatar")}
                          >
                          <input
                            type="file"
                            ref={avatarInputRef}
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              e.target.value = '';
                              // Open crop modal with the raw image
                              setPendingAvatar({ file, url: URL.createObjectURL(file) });
                            }}
                          />
                          {editAvatarPreview || editAvatarAssetId ? (
                            <img
                              src={editAvatarPreview || (editAvatarAssetId ? avatarUrl(editAvatarAssetId) : "")}
                              alt=""
                              className="h-full w-full object-cover object-top"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-t3 transition-colors group-hover:text-accent-t">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                                <circle cx="12" cy="13" r="4"/>
                              </svg>
                            </div>
                          )}
                          </div>
                          {/* Remove button — outside the overflow-hidden circle */}
                          {(editAvatarPreview || editAvatarAssetId) && (
                            <button
                              type="button"
                              className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-surface border border-border text-t4 opacity-0 transition-all hover:text-danger group-hover:opacity-100 z-10"
                              onClick={(e) => {
                                e.stopPropagation();
                                form.setValue("avatarAssetId", null, { shouldDirty: true });
                                form.setValue("avatarPreview", null);
                                if (avatarInputRef.current) avatarInputRef.current.value = "";
                              }}
                              title={t("remove_avatar")}
                            >
                              <svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                            </button>
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            className="w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none transition-colors focus:border-accent"
                            {...form.register("name")}
                            placeholder={t("persona_name_placeholder")}
                          />
                          {errors.name && (
                            <div className="text-[11px] text-red-400 mt-0.5">{errors.name.message}</div>
                          )}
                          <select
                            className="mt-2 w-full rounded border border-border bg-s2 py-2 pl-2.5 sel-arrow font-ui text-sm text-t1 outline-none transition-colors focus:border-accent"
                            value={editPronouns || ""}
                            onChange={(e) => form.setValue("pronouns", e.target.value, { shouldDirty: true })}
                          >
                            <option value="">{t("pronouns_none")}</option>
                            <option value="he/him">he/him</option>
                            <option value="she/her">she/her</option>
                            <option value="they/them">they/them</option>
                            <option value="it/its">it/its</option>
                            <option value="custom">{t("pronouns_custom")}</option>
                          </select>
                          {editPronouns === "custom" && (
                            <input
                              className="mt-1 w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none transition-colors focus:border-accent"
                              value={editPronounsCustom}
                              onChange={(e) => form.setValue("pronounsCustom", e.target.value, { shouldDirty: true })}
                              placeholder={t("pronouns_custom_placeholder")}
                            />
                          )}
                        </div>
                      </div>
                      <AutoTextarea
                        className="mb-1 w-full resize-none rounded border border-border bg-s2 py-2 px-2.5 font-ui text-xs text-t1 outline-none transition-colors focus:border-accent"
                        style={{ minHeight: 60 }}
                        value={form.watch("description")}
                        onChange={(e) => form.setValue("description", e.target.value, { shouldDirty: true })}
                        placeholder={t("persona_desc_placeholder")}
                      />
                      <PersonaTokenBadge text={editDescription} />
                      <div className="flex gap-2">
                        <button
                          className="h-[34px] cursor-pointer rounded-md bg-accent py-0 px-[18px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110"
                          disabled={input.isSaving || !(editName || "").trim()}
                          onClick={commitEdit}
                        >
                          {input.isSaving ? t("saving") : t("save")}
                        </button>
                        <button
                          className="h-[34px] cursor-pointer rounded-md bg-transparent py-0 px-3.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
                          onClick={cancelEdit}
                        >
                          {t("cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ── Non-editing state ── */
                    <>
                      <div className={cn(
                        "flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-base",
                        isSelected ? "bg-accent text-white" : "bg-s3 text-t2"
                      )}>
                        {persona.avatarAssetId
                          ? <img src={avatarUrl(persona.avatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                          : persona.name.slice(0, 1).toUpperCase()
                        }
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between">
                          <div className="font-ui mb-[3px] text-[length:var(--ui-fs)] font-medium text-t1">{persona.name}</div>
                          <PersonaPreviewBadge text={persona.description} />
                        </div>
                        {resolvePronounsDisplay(persona) && (
                          <div className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{resolvePronounsDisplay(persona)}</div>
                        )}
                        <div className="line-clamp-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t3">{persona.description}</div>
                        <div className="flex gap-0">
                          <div
                            className="mt-2 flex cursor-pointer items-center gap-1 rounded py-[3px] px-[7px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:bg-s2 hover:text-t2"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); startEdit(persona); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); startEdit(persona); } }}
                          >
                            <Icons.Edit /> {t("persona_edit")}
                          </div>
                          <div
                            className="mt-2 flex cursor-pointer items-center gap-1 rounded py-[3px] px-[7px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:bg-s2 hover:text-t2"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); input.onDuplicatePersona(persona.id); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); input.onDuplicatePersona(persona.id); } }}
                          >
                            <Icons.Copy /> {t("persona_duplicate")}
                          </div>
                          <div
                            className="mt-2 flex cursor-pointer items-center gap-1 rounded py-[3px] px-[7px] font-ui text-[calc(var(--ui-fs)-3px)] transition-all hover:bg-s2"
                            role="button"
                            tabIndex={0}
                            style={{ color: isLastPersona ? "var(--t3)" : "oklch(0.6 0.15 25)", cursor: isLastPersona ? "not-allowed" : "pointer", opacity: isLastPersona ? 0.6 : 1 }}
                            title={isLastPersona ? t("cannot_delete_last_persona") : t("delete_persona_title")}
                            onClick={(e) => { e.stopPropagation(); handleDelete(persona.id); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); handleDelete(persona.id); } }}
                          >
                            <Icons.Trash /> {t("delete")}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {/* Add persona button */}
            <div
              className="flex items-center justify-center rounded-lg border border-dashed border-border2 p-2.5 font-ui text-xs text-t2 transition-all hover:bg-s2 hover:text-t1 hover:border-border cursor-pointer"
              onClick={async () => {
                const created = await input.onCreatePersona({ name: t("new_persona_default"), description: "" });
                if (created) {
                  setSelectedId(created.id);
                  setEditingId(created.id);
                  form.reset({
                    name: t("new_persona_default"),
                    description: "",
                    pronouns: "",
                    pronounsCustom: "",
                    avatarAssetId: null,
                    avatarPreview: null,
                  });
                }
              }}
            >
              <Icons.Plus /> <span className="ml-1">{t("create_new_persona")}</span>
            </div>
            {deleteConfirm && deleteConfirm.error && (
              <div className="font-ui text-[calc(var(--ui-fs)-3px)] mt-1 text-[oklch(0.6_0.15_25)]">{deleteConfirm.error}</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-[14px]">
          <button className="h-[37px] cursor-pointer rounded-md border border-border bg-surface py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
            {t("close")}
          </button>
          <button
            className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110"
            disabled={!selectedId || isEditing}
            onClick={setActiveAndClose}
          >
            {t("select_as_active")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
