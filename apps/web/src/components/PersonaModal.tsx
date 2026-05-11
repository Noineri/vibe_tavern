import { useState, useRef } from "react";
import { Icons } from "./shared/icons.js";
import { EmptyState } from "./shared/empty-state.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { cn } from "../lib/cn.js";
import { avatarUrl } from "../lib/avatar.js";
import { uploadAsset } from "../app-client.js";
import { useTokenCount } from "../hooks/use-token-count.js";
import { useT } from "../i18n/context.js";
import { useNavigationStore } from "../stores/navigation-store.js";

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
  onSaveEdit: (personaId: string, draft: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null }) => void;
  onSetActive: (personaId: string) => void;
  onCreatePersona: (input: { name: string; description: string; pronouns?: string | null }) => Promise<{ id: string } | null>;
  onDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
}

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
  const isOpen = useNavigationStore((s) => s.isPersonaModalOpen);
  const setIsOpen = useNavigationStore((s) => s.setIsPersonaModalOpen);
  const onClose = () => setIsOpen(false);
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPronouns, setEditPronouns] = useState("");
  const [editPronounsCustom, setEditPronounsCustom] = useState("");
  const [editAvatarAssetId, setEditAvatarAssetId] = useState<string | null>(null);
  const [editAvatarPreview, setEditAvatarPreview] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string>("");

  if (!isOpen) return null;

  const isEditing = editingId !== null;
  const isLastPersona = input.personas.length <= 1;

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    setEditName(persona.name);
    setEditDescription(persona.description);
    const raw = persona.pronouns ?? "";
    setEditPronouns(raw);
    setEditPronounsCustom("");
    setEditAvatarAssetId(persona.avatarAssetId);
    setEditAvatarPreview(null);
  }

  function commitEdit(): void {
    if (!editingId || !editName.trim()) return;
    const resolved = editPronouns === "custom"
      ? (editPronounsCustom.trim() || null)
      : (editPronouns || null);
    input.onSaveEdit(editingId, { name: editName.trim(), description: editDescription, pronouns: resolved, avatarAssetId: editAvatarAssetId });
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

  function handleDelete(personaId: string): void {
    if (isLastPersona) {
      setDeleteError(t("cannot_delete_last_persona"));
      return;
    }
    setConfirmDeleteId(personaId);
    setDeleteError("");
  }

  function resolvePronounsDisplay(persona: PersonaListItem): string | null {
    if (!persona.pronouns) return null;
    return persona.pronouns;
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {confirmDeleteId && (
        <DestructiveConfirmModal
          title={t("delete_persona_title")}
          body={
            <>
              {t("delete_persona_body").replace("{name}", input.personas.find((p) => p.id === confirmDeleteId)?.name ?? "Untitled")}
              {deleteError && <div style={{ marginTop: 8, color: "oklch(0.6 0.15 25)" }}>{deleteError}</div>}
            </>
          }
          confirmLabel={t("delete")}
          onConfirm={async () => {
            const id = confirmDeleteId;
            if (!id) return;
            const result = await input.onDeletePersona(id);
            if (result.ok) {
              setConfirmDeleteId(null);
              setDeleteError("");
              if (selectedId === id) setSelectedId(null);
            } else {
              setDeleteError(result.error ?? t("delete_failed"));
            }
          }}
          onCancel={() => {
            setConfirmDeleteId(null);
            setDeleteError("");
          }}
        />
      )}
      <div
        className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[500px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0" style={{ padding: "18px 20px 0" }}>
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
        <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
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
                        <div
                          className={cn(
                            "group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent hover:text-accent-t",
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
                              setAvatarUploading(true);
                              try {
                                const preview = URL.createObjectURL(file);
                                setEditAvatarPreview(preview);
                                const result = await uploadAsset(file);
                                setEditAvatarAssetId(result.assetId);
                              } catch {
                                setEditAvatarPreview(null);
                                setEditAvatarAssetId(null);
                              } finally {
                                setAvatarUploading(false);
                              }
                            }}
                          />
                          {editAvatarPreview || editAvatarAssetId ? (
                            <>
                              <img
                                src={editAvatarPreview || (editAvatarAssetId ? avatarUrl(editAvatarAssetId) : "")}
                                alt=""
                                className="h-full w-full object-cover object-top"
                              />
                              <button
                                type="button"
                                className="absolute right-0.5 bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-t4 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditAvatarAssetId(null);
                                  setEditAvatarPreview(null);
                                  if (avatarInputRef.current) avatarInputRef.current.value = "";
                                }}
                                title={t("remove_avatar")}
                              >
                                <svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                              </button>
                            </>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-t3 transition-colors group-hover:text-accent-t">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                                <circle cx="12" cy="13" r="4"/>
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            className="w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none transition-colors focus:border-accent"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder={t("persona_name_placeholder")}
                          />
                          <select
                            className="mt-2 w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none transition-colors focus:border-accent"
                            value={editPronouns || ""}
                            onChange={(e) => setEditPronouns(e.target.value)}
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
                              onChange={(e) => setEditPronounsCustom(e.target.value)}
                              placeholder={t("pronouns_custom_placeholder")}
                            />
                          )}
                        </div>
                      </div>
                      <textarea
                        className="mb-1 w-full min-h-[60px] rounded border border-border bg-s2 py-2 px-2.5 font-ui text-xs text-t1 outline-none transition-colors focus:border-accent"
                        style={{ resize: "vertical" }}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        placeholder={t("persona_desc_placeholder")}
                      />
                      <PersonaTokenBadge text={editDescription} />
                      <div className="flex gap-2">
                        <button
                          className="h-[34px] cursor-pointer rounded-md bg-accent py-0 px-[18px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110"
                          disabled={input.isSaving || !editName.trim()}
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
                            style={{ opacity: 0.45, cursor: "not-allowed" }}
                            title={t("duplicate_not_implemented")}
                            onClick={(e) => e.stopPropagation()}
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
                  setEditName(t("new_persona_default"));
                  setEditDescription("");
                  setEditPronouns("");
                  setEditPronounsCustom("");
                }
              }}
            >
              <Icons.Plus /> <span className="ml-1">{t("create_new_persona")}</span>
            </div>
            {deleteError && !confirmDeleteId && (
              <div className="font-ui text-[calc(var(--ui-fs)-3px)] mt-1" style={{ color: "oklch(0.6 0.15 25)" }}>{deleteError}</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border" style={{ padding: "14px 20px" }}>
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
    </div>
  );
}
