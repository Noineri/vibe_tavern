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
import { Modal } from "../shared/Modal.js";
import { avatarUrl } from "../../lib/avatar.js";
import { uploadAsset } from "../../app-client.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";

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
  return <span className="font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} tokens</span>;
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
    setSelectedId(persona.id);
    form.reset({
      name: persona.name,
      description: persona.description,
      pronouns: PRONOUN_OPTIONS.some(o => o.v === persona.pronouns) ? (persona.pronouns ?? "") : "custom",
      pronounsCustom: PRONOUN_OPTIONS.some(o => o.v === persona.pronouns) ? "" : (persona.pronouns ?? ""),
      avatarAssetId: persona.avatarAssetId,
      avatarFullAssetId: null,
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

  function setActiveAndClose(): void {
    const persona = input.personas.find((p) => p.id === selectedId) || input.personas[0];
    if (persona) input.onSetActive(persona.id);
    onClose();
  }

  function handleAvatarCropConfirm(result: AvatarCropResult): void {
    form.setValue("avatarPreview", result.croppedUrl);
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

  const editName = form.watch("name");
  const editDescription = form.watch("description");
  const editPronouns = form.watch("pronouns");
  const editPronounsCustom = form.watch("pronounsCustom");
  const editAvatarAssetId = form.watch("avatarAssetId");
  const editAvatarPreview = form.watch("avatarPreview");

  const editDisplayAvatar = editAvatarPreview
    || (editAvatarAssetId ? avatarUrl(editAvatarAssetId) : null);

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
    const isSelected = selectedId === persona.id;
    const editingThis = editingId === persona.id;
    const avatar = persona.avatarAssetId ? avatarUrl(persona.avatarAssetId) : null;

    return (
      <div
        key={persona.id}
        className={cn(
          "group flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all duration-200",
          isMobile ? "active:bg-s2" : "hover:bg-s2",
          isSelected && !isEditing ? "border-accent bg-accent-dim" : "border-transparent",
        )}
        onClick={() => { if (!isEditing) setSelectedId(persona.id); }}
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
                    <img src={editDisplayAvatar} alt="" className="h-full w-full object-cover object-top" />
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
                className="min-h-[40px] cursor-pointer rounded-md bg-accent px-4 font-ui text-sm font-medium text-white transition-all hover:brightness-110"
                disabled={input.isSaving || !(editName || "").trim()}
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
                isSelected ? "bg-accent text-white" : "bg-s3 text-t2",
              )}
            >
              {avatar
                ? <img src={avatar} alt="" className="h-full w-full object-cover object-top" />
                : persona.name.slice(0, 1).toUpperCase()
              }
            </div>
            {/* Info */}
            <div className="min-w-0 flex-1 overflow-hidden py-0.5">
              <div className="font-ui text-[15px] font-semibold tracking-tight text-t1">{persona.name}</div>
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
                  <div className="absolute right-0 top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
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
          originalFile={pendingAvatar.file}
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
      {/* Add persona */}
      <div
        className={cn("flex shrink-0 items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "mx-4 mb-2 min-h-[48px] text-[14px]" : "mx-5 mb-2 py-3 text-sm")}
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
              avatarPreview: null,
            });
          }
        }}
      >
        <Icons.Plus /> {t("create_new_persona")}
      </div>
      {/* Footer */}
      <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "px-4 py-3" : "px-5 py-3.5")}>
        <button type="button"
          className={cn("cursor-pointer rounded-md font-ui font-medium text-t2 transition-all hover:text-t1", isMobile ? "min-h-[44px] flex-1 text-[14px]" : "h-[37px] px-[21px] text-[calc(var(--ui-fs)-2px)]")}
          onClick={onClose}
        >
          {t("cancel_btn")}
        </button>
        <button type="button"
          className={cn("cursor-pointer rounded-md bg-accent font-ui font-medium text-white shadow-lg shadow-accent/20 transition-all hover:brightness-110 active:scale-[0.98]", isMobile ? "min-h-[44px] flex-1 text-[14px]" : "h-[37px] px-[21px] text-[calc(var(--ui-fs)-2px)]")}
          disabled={!selectedId || isEditing}
          onClick={setActiveAndClose}
        >
          {t("select_as_active")}
        </button>
      </div>
    </>
  );

  // ── Mobile: fullscreen sheet ──
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[500] flex flex-col bg-surface">
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
