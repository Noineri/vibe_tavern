import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { Icons } from "../shared/icons.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { AvatarCropModal } from "../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../shared/AvatarCropModal.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { Checkbox } from "../shared/Checkbox.js";
import { Modal } from "../shared/Modal.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

import { createPersona, uploadPersonaAvatar } from "../../app-client.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { parseStPersonas, type StPersonaEntry } from "../../lib/st-persona-parser.js";
import { toast } from "sonner";
import { fetchBootstrapAction, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";

interface PersonaListItem {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  avatarExt: string | null;
  avatarCropJson: string | null;
  defaultForNewChats: boolean;
  updatedAt: string;
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
  onSetDefaultPersona: (personaId: string) => Promise<void>;
}

type PersonaFormData = {
  name: string;
  description: string;
  pronouns: string | null;
  pronounsCustom: string;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  avatarPreview: string | null;
};


function PersonaTokenBadge({ text }: { text: string }) {
  const { t } = useT();
  const count = useTokenCount(text);
  return <span className="font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} {t("tokens_label")}</span>;
}

export function PersonaModal(input: PersonaModalProps) {
  const { t } = useT();
  const isOpen = useModalStore((s) => s.isPersonaModalOpen);
  const setIsOpen = useModalStore((s) => s.setIsPersonaModalOpen);
  const onClose = () => {
    void discardCreatedDraft();
    setIsOpen(false);
  };
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createdDraftPersonaId, setCreatedDraftPersonaId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; error: string } | null>(null);
  const isMobile = useIsMobile();

  // ── ST persona import state ──
  const [stImportPreview, setStImportPreview] = useState<StPersonaEntry[] | null>(null);
  const [stImportSelected, setStImportSelected] = useState<Set<string>>(new Set());
  const [stImporting, setStImporting] = useState(false);
  const [stImportProgress, setStImportProgress] = useState<{ current: number; total: number } | null>(null);
  const stFolderRef = useRef<HTMLInputElement>(null);
  const stAvatarFiles = useRef<Map<string, File>>(new Map());

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
      avatarCropJson: null,
      avatarPreview: null,
    },
  });

  if (!isOpen) return null;

  const isEditing = editingId !== null;
  const isLastPersona = input.personas.length <= 1;

  // ── ST persona import functions ──
  async function handleStFolderPick(files?: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;

    // Find settings.json and avatar PNGs in the picked folder
    let settingsFile: File | null = null;
    const avatarMap = new Map<string, File>();

    for (const file of Array.from(files)) {
      const rp = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (!rp) continue;

      if (rp.endsWith("/settings.json")) {
        settingsFile = file;
      }
      // Match .../User Avatars/<key>.png
      const parts = rp.split("/");
      const avIdx = parts.lastIndexOf("User Avatars");
      if (avIdx >= 0 && file.name.toLowerCase().endsWith(".png")) {
        avatarMap.set(file.name, file);
      }
    }

    if (!settingsFile) {
      toast.error(t("st_no_settings_json"));
      return;
    }

    try {
      const text = await settingsFile.text();
      const parsed = JSON.parse(text);
      const entries = parseStPersonas(parsed);
      if (entries.length === 0) {
        toast.error(t("st_no_personas_found"));
        return;
      }
      stAvatarFiles.current = avatarMap;
      setStImportPreview(entries);
      setStImportSelected(new Set(entries.map(e => e.key)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("st_parse_failed"));
    }
  }

  async function handleStImport(): Promise<void> {
    if (!stImportPreview || stImportPreview.length === 0) return;
    const toImport = stImportPreview.filter(e => stImportSelected.has(e.key));
    if (toImport.length === 0) return;
    setStImporting(true);
    setStImportProgress({ current: 0, total: toImport.length });

    let imported = 0;
    let didSetDefault = false;
    const errors: string[] = [];
    for (let i = 0; i < toImport.length; i++) {
      const entry = toImport[i];
      setStImportProgress({ current: i + 1, total: toImport.length });
      try {
        const shouldSetDefault = entry.isDefault && !didSetDefault;
        const persona = await createPersona({
          name: entry.name,
          description: entry.description,
          defaultForNewChats: shouldSetDefault ? true : undefined,
        });
        if (shouldSetDefault) didSetDefault = true;

        // Upload avatar to the persona's entity folder (sets avatarExt).
        const avatarFile = stAvatarFiles.current.get(entry.key);
        if (avatarFile) {
          try {
            await uploadPersonaAvatar(persona.id, avatarFile);
          } catch {
            // Avatar upload failure is non-critical
          }
        }

        imported++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${entry.name}: ${reason}`);
      }
    }

    stAvatarFiles.current = new Map();
    setStImporting(false);
    setStImportProgress(null);
    setStImportPreview(null);

    await fetchBootstrapAction({ silent: true });
    await fetchPersonasAction();
    toast.success(t("st_persona_import_result").replace("{count}", String(imported)));
    if (errors.length > 0) {
      toast.warning(t("st_import_errors").replace("{count}", String(errors.length)));
    }
  }

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    setSelectedId(persona.id);
    form.reset({
      name: persona.name,
      description: persona.description,
      pronouns: PRONOUN_OPTIONS.some(o => o.v === persona.pronouns) ? (persona.pronouns ?? "") : "custom",
      pronounsCustom: PRONOUN_OPTIONS.some(o => o.v === persona.pronouns) ? "" : (persona.pronouns ?? ""),
      avatarAssetId: persona.avatarAssetId,
      avatarFullAssetId: null,
      avatarCropJson: null,
      avatarPreview: null,
    });
  }

  function discardCreatedDraft(): void {
    const draftId = createdDraftPersonaId;
    if (!draftId) return;
    setCreatedDraftPersonaId(null);
    setEditingId((current) => current === draftId ? null : current);
    setSelectedId((current) => current === draftId ? input.activePersonaId : current);
    void input.onDeletePersona(draftId).catch(() => undefined);
  }

  function commitEdit(): void {
    if (!editingId) return;
    const name = form.getValues("name");
    const description = form.getValues("description");
    const pronouns = form.getValues("pronouns");
    const pronounsCustom = form.getValues("pronounsCustom");
    const avatarAssetId = form.getValues("avatarAssetId");
    const avatarFullAssetId = form.getValues("avatarFullAssetId");
    const avatarCropJson = form.getValues("avatarCropJson");
    if (!name.trim()) return;
    const resolved = pronouns === "custom"
      ? (pronounsCustom.trim() || null)
      : (pronouns || null);
    input.onSaveEdit(editingId, { name: name.trim(), description, pronouns: resolved, avatarAssetId, avatarFullAssetId });
    if (createdDraftPersonaId === editingId) setCreatedDraftPersonaId(null);
    setEditingId(null);
  }

  function cancelEdit(): void {
    if (editingId === createdDraftPersonaId) {
      discardCreatedDraft();
      return;
    }
    setEditingId(null);
  }

  function handleAvatarCropConfirm(result: AvatarCropResult): void {
    if (!editingId) return;
    const targetId = editingId;
    form.setValue("avatarPreview", pendingAvatar!.url);
    setAvatarUploading(true);
    // Folder-resident upload: the crop is written to {id}/avatar.{ext}
    // (thumbnail) and the uncropped source to {id}/avatar-full.{ext} (large
    // slots). avatarExt is set, legacy avatarAssetId cleared.
    uploadPersonaAvatar(targetId, result.croppedFile, pendingAvatar!.file)
      .then(() => {
        // Backend cleared avatarAssetId; null these so onSaveEdit won't re-send
        // stale legacy ids (PATCH never touches avatarExt either way).
        form.setValue("avatarAssetId", null, { shouldDirty: true });
        form.setValue("avatarFullAssetId", null, { shouldDirty: true });
        void fetchPersonasAction();
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

  const editName = form.watch("name");
  const isDirty = form.formState.isDirty;
  const editDescription = form.watch("description");
  const editPronouns = form.watch("pronouns");
  const editPronounsCustom = form.watch("pronounsCustom");
  const editAvatarAssetId = form.watch("avatarAssetId");
  const editAvatarPreview = form.watch("avatarPreview");

  const editingPersona = input.personas.find(p => p.id === editingId) ?? null;
  const editDisplayAvatar = editAvatarPreview
    ?? (editingId ? resolveEntityAvatarUrl({ kind: "personas", id: editingId, avatarExt: editingPersona?.avatarExt ?? null, avatarAssetId: editAvatarAssetId, updatedAt: editingPersona?.updatedAt ?? null }) : null);
  const editAvatarCropJson = form.watch("avatarCropJson");

  const PRONOUN_OPTIONS: { v: string; l: string }[] = [
    { v: "", l: t("pronouns_none") },
    { v: "he/him", l: "he/him" },
    { v: "she/her", l: "she/her" },
    { v: "they/them", l: "they/them" },
    { v: "it/its", l: "it/its" },
    { v: "custom", l: t("pronouns_custom") },
  ];

  // ── Card rendering ──
  const renderCard = (persona: PersonaListItem) => {
    const isActive = input.activePersonaId === persona.id;
    const editingThis = editingId === persona.id;
    const avatar = resolveEntityAvatarUrl({ kind: "personas", id: persona.id, avatarExt: persona.avatarExt, avatarAssetId: persona.avatarAssetId, updatedAt: persona.updatedAt });

    return (
      <div
        key={persona.id}
        className={cn(
          "group flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all duration-200",
          isMobile ? "active:bg-s2" : "hover:bg-s2",
          isActive && !isEditing ? "border-accent bg-accent-dim" : "border-transparent",
        )}
        onClick={() => { if (!isEditing) input.onSetActive(persona.id); }}
      >
        {editingThis ? (
          /* ── EDITING ── */
          <div className="w-full" onClick={(e) => e.stopPropagation()}>
            {/* Avatar + Name + Pronouns row */}
            <div className={cn("flex gap-3 mb-3", isMobile ? "items-start" : "items-start")}>
              {/* Avatar */}
              <div className="group/ava relative shrink-0">
                <CustomTooltip content={t("upload_avatar")}>
                <div
                  className={cn(
                    "relative flex cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent",
                    isMobile ? "h-[68px] w-[68px]" : "h-16 w-16",
                    avatarUploading && "pointer-events-none opacity-60",
                  )}
                  onClick={() => !avatarUploading && avatarInputRef.current?.click()}
                >
                  <input
                    type="file" ref={avatarInputRef} accept="image/*" className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = "";
                      setPendingAvatar({ file, url: URL.createObjectURL(file) });
                    }}
                  />
                  {editDisplayAvatar ? (
                    <img src={editDisplayAvatar} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="text-t3 transition-colors group-hover/ava:text-accent-t">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                    </div>
                  )}
                </div>
                </CustomTooltip>
                {editDisplayAvatar && (
                  <button type="button"
                    className="absolute -right-1 -bottom-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-t4 opacity-0 transition-all hover:text-danger group-hover/ava:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      form.setValue("avatarAssetId", null, { shouldDirty: true });
                      form.setValue("avatarPreview", null);
                      if (avatarInputRef.current) avatarInputRef.current.value = "";
                    }}
                  >
                    <Icons.Close />
                  </button>
                )}
              </div>
              {/* Name + Pronouns */}
              <div className="flex-1 min-w-0">
                <input
                  className="w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none focus:border-accent"
                  value={editName}
                  onChange={(e) => form.setValue("name", e.target.value, { shouldDirty: true })}
                  placeholder={t("persona_name_placeholder")}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {PRONOUN_OPTIONS.map((opt) => (
                    <button  key={opt.v}
                      type="button"
                      className={cn(
                        "rounded-md px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-2px)] transition-all",
                        editPronouns === opt.v
                          ? "bg-accent/20 text-accent-t ring-1 ring-accent/40"
                          : "bg-s3 text-t3 ring-1 ring-transparent hover:text-t2",
                      )}
                      onClick={() => form.setValue("pronouns", opt.v, { shouldDirty: true })}
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>
                {editPronouns === "custom" && (
                  <input
                    className="mt-1 w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none focus:border-accent"
                    value={editPronounsCustom}
                    onChange={(e) => form.setValue("pronounsCustom", e.target.value, { shouldDirty: true })}
                    placeholder={t("pronouns_custom_placeholder")}
                  />
                )}
              </div>
            </div>
            {/* Description */}
            <div className="relative mb-3">
              <AutoTextarea
                className="w-full min-h-[60px] rounded border border-border bg-s2 py-2 px-2.5 font-ui text-xs text-t1 outline-none resize-none focus:border-accent"
                style={{ minHeight: 60 }}
                value={editDescription}
                onChange={(e) => form.setValue("description", e.target.value, { shouldDirty: true })}
                placeholder={t("persona_desc_placeholder")}
              />
              <div className="absolute bottom-2 right-2">
                <PersonaTokenBadge text={editDescription} />
              </div>
            </div>
            {/* Save / Cancel */}
            <div className="flex gap-2">
              <button type="button"
                className="min-h-[40px] cursor-pointer rounded-md bg-accent px-4 font-ui text-sm font-medium text-on-accent transition-all hover:brightness-110"
                disabled={input.isSaving || !isDirty || !(editName || "").trim()}
                onClick={commitEdit}
              >
                {input.isSaving ? t("saving") : t("save_btn")}
              </button>
              <button type="button"
                className="min-h-[40px] cursor-pointer rounded-md bg-transparent px-3.5 font-ui text-sm text-t3 active:bg-s2"
                onClick={cancelEdit}
              >
                {t("cancel_btn")}
              </button>
            </div>
          </div>
        ) : (
          /* ── DISPLAY ── */
          <>
            {/* Avatar */}
            <div
              className={cn(
                "flex shrink-0 items-center justify-center overflow-hidden rounded-full text-base shadow-inner ring-1 ring-white/5",
                isMobile ? "h-[68px] w-[68px]" : "h-[88px] w-[88px] text-lg",
                // Colored bg is a fallback for the initials only. An avatar
                // <img> sits on top and PNG transparency would otherwise let
                // the active-state accent bleed through — so always use the
                // neutral --s3 behind an image. Active state is already shown
                // by the card's border-accent + bg-accent-dim.
                avatar
                  ? "bg-s3"
                  : isActive
                    ? "bg-accent text-on-accent"
                    : "bg-s3 text-t2",
              )}
            >
              {avatar
                ? <img src={avatar} alt="" className="h-full w-full object-cover" />
                : persona.name.slice(0, 1).toUpperCase()
              }
            </div>
            {/* Info */}
            <div className="min-w-0 flex-1 overflow-hidden py-0.5">
              <div className="flex items-center gap-2">
                <div className="font-ui text-[15px] font-semibold tracking-tight text-t1">{persona.name}</div>
                {persona.defaultForNewChats && (
                  <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-ui text-[10px] font-medium tracking-wide text-accent-t uppercase">{t("default_persona_badge")}</span>
                )}
              </div>
              {persona.pronouns && (
                <div className="font-ui text-[13px] text-t3">{persona.pronouns}</div>
              )}
              <div className={cn("font-ui text-[13px] leading-snug text-t3", isMobile ? "line-clamp-2" : "line-clamp-3")}>{persona.description}</div>
              <PersonaTokenBadge text={persona.description} />
            </div>
            {/* Actions */}
            <div className="relative flex shrink-0 items-start gap-0.5 self-start">
              <CustomTooltip content={t("persona_edit")}>
                <div
                  className={cn("flex cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3", isMobile ? "min-h-[44px] min-w-[44px]" : "h-7 w-7")}
                  onClick={(e) => { e.stopPropagation(); startEdit(persona); }}
                >
                  <Icons.Edit />
                </div>
              </CustomTooltip>
              <div
                className={cn("flex cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3", isMobile ? "min-h-[44px] min-w-[44px]" : "h-7 w-7")}
                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === persona.id ? null : persona.id); }}
              >
                <Icons.ellipsis />
              </div>
              {menuOpenId === persona.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); }} />
                  <div className="glass-blur absolute right-0 top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-glass-bg py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
                    {!persona.defaultForNewChats && (
                      <>
                        <div
                          className="flex min-h-[44px] cursor-pointer items-center gap-2.5 px-4 py-1.5 font-ui text-[14px] text-t2 transition-colors hover:bg-s2 active:bg-s3"
                          onClick={(e) => { e.stopPropagation(); input.onSetDefaultPersona(persona.id); setMenuOpenId(null); }}
                        >
                          <Icons.Star /> {t("set_default_persona")}
                        </div>
                        <div className="mx-3 my-1 border-t border-border" />
                      </>
                    )}
                    <div
                      className="flex min-h-[44px] cursor-pointer items-center gap-2 px-4 font-ui text-[14px] text-t2 transition-colors hover:bg-s2 active:bg-s3"
                      onClick={(e) => { e.stopPropagation(); input.onDuplicatePersona(persona.id); setMenuOpenId(null); }}
                    >
                      <Icons.Copy /> {t("duplicate")}
                    </div>
                    <div className="mx-3 my-1 border-t border-border" />
                    <div
                      className={cn("flex min-h-[44px] cursor-pointer items-center gap-2 px-4 font-ui text-[14px] transition-colors", isLastPersona ? "text-t4" : "text-danger hover:bg-danger-dim active:bg-danger/20")}
                      onClick={(e) => { e.stopPropagation(); if (!isLastPersona) { handleDelete(persona.id); setMenuOpenId(null); } }}
                    >
                      <Icons.del /> {t("delete")}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  // ── Content ──
  const content = (
    <>
      {/* Avatar crop modal */}
      {pendingAvatar && (
        <AvatarCropModal
          imageUrl={pendingAvatar.url}
          onConfirm={handleAvatarCropConfirm}
          onCancel={handleAvatarCropCancel}
        />
      )}
      {/* Delete confirm */}
      {deleteConfirm && (
        <DestructiveConfirmModal
          title={t("delete_persona_title")}
          body={
            <>
              {t("delete_persona_body").replace("{name}", input.personas.find((p) => p.id === deleteConfirm.id)?.name ?? "Untitled")}
              {deleteConfirm.error && <div className="mt-2 text-danger">{deleteConfirm.error}</div>}
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
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
      {/* Header */}
      <div className={cn("shrink-0", isMobile ? "px-4 py-3" : "pt-[18px] px-5 pb-0")}>
        <div className="flex items-start justify-between">
          <div>
            <div className={cn("font-body font-medium text-t1", isMobile ? "text-[calc(var(--ui-fs)+2px)]" : "text-[calc(var(--ui-fs)+4px)]")}>{t("persona_manager_title")}</div>
            {!isMobile && <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3 mt-0.5">{t("persona_manager_sub")}</div>}
          </div>
          <div
            className={cn("flex shrink-0 cursor-pointer items-center justify-center text-t3 transition-all hover:bg-s2 hover:text-t1 active:bg-s2", isMobile ? "min-h-[44px] min-w-[44px] rounded-lg" : "h-[32px] w-[32px] rounded-[5px]")}
            onClick={onClose}
          >
            <Icons.Close />
          </div>
        </div>
      </div>
      {/* Body */}
      <div className={cn("flex-1 overflow-y-auto", isMobile ? "px-4 py-2" : "p-5")}>
        {input.personas.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 text-t4"><Icons.User /></div>
            <div className="font-ui text-[14px] font-medium text-t2">{t("no_personas")}</div>
            <div className="font-ui text-[12px] text-t3 mt-1">{t("create_first_persona")}</div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {input.personas.map(renderCard)}
        </div>
      </div>
      {/* Footer: Create + ST Import */}
      <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "px-4 py-3" : "px-5 py-3.5")}>
        <div
          className={cn("flex flex-1 items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] text-[14px]" : "py-2.5 text-sm")}
          style={{ color: "var(--t2)" }}
          onClick={async () => {
            discardCreatedDraft();
            const created = await input.onCreatePersona({ name: t("new_persona_default"), description: "" });
            if (created) {
              setCreatedDraftPersonaId(created.id);
              setSelectedId(created.id);
              setEditingId(created.id);
              form.reset({
                name: t("new_persona_default"),
                description: "",
                pronouns: "",
                pronounsCustom: "",
                avatarAssetId: null,
                avatarFullAssetId: null,
                avatarCropJson: null,
                avatarPreview: null,
              });
            }
          }}
        >
          <Icons.Plus /> {t("create_new_persona")}
        </div>
        <CustomTooltip content={t("st_persona_import_hint")}>
          <button type="button"
            className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] px-4 text-[14px]" : "h-[44px] px-4 text-sm")}
            style={{ color: "var(--t2)" }}
            onClick={() => stFolderRef.current?.click()}
          >
            <Icons.Import /> {t("st_import_personas_btn")}
          </button>
        </CustomTooltip>
      </div>
      {/* ST persona import preview */}
      {stImportPreview && (
        <div className={cn("shrink-0 rounded-lg border border-border2 bg-s2 mx-5 mb-2 p-4")}>
          <div className="font-ui text-sm font-medium text-t1 mb-2">{t("st_persona_preview_title").replace("{count}", String(stImportSelected.size))}</div>
          <div className="max-h-[200px] overflow-y-auto space-y-1.5">
            {stImportPreview.map((entry, idx) => (
              <div key={entry.key} className="flex items-start gap-2 rounded-md bg-surface px-3 py-2">
                <Checkbox
                  checked={stImportSelected.has(entry.key)}
                  onChange={() => {
                    setStImportSelected(prev => {
                      const next = new Set(prev);
                      if (next.has(entry.key)) next.delete(entry.key);
                      else next.add(entry.key);
                      return next;
                    });
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-ui text-[13px] font-medium text-t1">{entry.name}</span>
                  </div>
                  {entry.description && (
                    <div className="font-ui text-[12px] text-t3 line-clamp-2 mt-0.5">{entry.description.slice(0, 120)}{entry.description.length > 120 ? "..." : ""}</div>
                  )}
                </div>
                <Checkbox
                  checked={entry.isDefault}
                  label={t("default_persona_badge")}
                  onChange={() => {
                    if (!stImportPreview) return;
                    const updated = stImportPreview.map((e, i) => ({ ...e, isDefault: i === idx ? !e.isDefault : false }));
                    setStImportPreview(updated);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button type="button"
              className="h-[34px] cursor-pointer rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-45"
              disabled={stImporting || stImportSelected.size === 0}
              onClick={() => void handleStImport()}
            >
              {stImporting ? t("importing") : t("st_persona_confirm_import")}
            </button>
            <button type="button"
              className="h-[34px] cursor-pointer rounded-md px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
              onClick={() => setStImportPreview(null)}
              disabled={stImporting}
            >
              {t("cancel_btn")}
            </button>
          </div>
          {stImporting && stImportProgress && (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-s3">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${(stImportProgress.current / stImportProgress.total) * 100}%` }}
                />
              </div>
              <div className="mt-1 font-ui text-[11px] text-t3">
                {t("st_persona_importing").replace("{current}", String(stImportProgress.current)).replace("{total}", String(stImportProgress.total))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Hidden folder input for ST import */}
      <input
        ref={stFolderRef}
        className="hidden"
        type="file"
        /** @ts-expect-error webkitdirectory is not in React types */
        webkitdirectory=""
        directory=""
        onChange={(e) => void handleStFolderPick(e.target.files)}
      />
    </>
  );

  // ── Mobile: fullscreen sheet ──
  if (isMobile) {
    return (
      <div className="glass-blur fixed inset-0 z-[500] flex flex-col bg-glass-bg">
        {content}
      </div>
    );
  }

  // ── Desktop: centered modal ──
  return (
    <Modal open={true} onClose={onClose}>
      <div className="flex max-h-[calc(100vh-40px)] max-w-[calc(100vw-32px)] w-[600px] h-[680px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-theme-lg">
        {content}
      </div>
    </Modal>
  );
}
