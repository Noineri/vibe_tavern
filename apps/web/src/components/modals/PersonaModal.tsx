import { useState, useRef, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import type { PronounForms } from "@vibe-tavern/domain";
import { Icons } from "../shared/icons.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ActionSheet, type ActionSheetItem } from "../shared/ActionSheet.js";
import { BoundResourcesField } from "../shared/BoundResourcesField.js";
import { AvatarCropModal } from "../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../shared/AvatarCropModal.js";
import { PersonaCardCollapsed } from "./PersonaCardCollapsed.js";
import { PersonaCardEditor } from "./PersonaCardEditor.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useStPersonaImport } from "../../hooks/use-st-persona-import.js";
import { useRevealOnCreate } from "../../hooks/use-reveal-on-create.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { Modal } from "../shared/Modal.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

import { uploadPersonaAvatar, exportPersona } from "../../app-client.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { toast } from "sonner";
import { fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { updatePersonaAction } from "../../stores/api-actions/persona-actions.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { describePersonaAvatar } from "../../api/gallery-api.js";
import { AvatarDescriptionField, type AvatarDescriptionPatch } from "../build/editors/AvatarDescriptionField.js";

export interface PersonaListItem {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  pronounForms: PronounForms | null;
  avatarAssetId: string | null;
  avatarExt: string | null;
  avatarCropJson: string | null;
  defaultForNewChats: boolean;
  // Avatar-appearance prompt injection (MEDIA_GALLERY). Fed straight from
  // the bootstrap PersonaRecord; the field reads/writes them out-of-band
  // via updatePersonaAction (NOT through this modal's onSaveEdit form).
  includeAvatarInPrompt: boolean;
  avatarDescription: string | null;
  updatedAt: string;
}

interface PersonaModalProps {
  personas: PersonaListItem[];
  activePersonaId: string | null;
  isSaving: boolean;
  onSaveEdit: (personaId: string, draft: { name: string; description: string; pronouns?: string | null; pronounForms?: PronounForms | null; avatarAssetId?: string | null; avatarFullAssetId?: string | null }) => void;
  onSetActive: (personaId: string) => void;
  onCreatePersona: (input: { name: string; description: string; pronouns?: string | null; pronounForms?: PronounForms | null }) => Promise<{ id: string } | null>;
  onDuplicatePersona: (personaId: string) => Promise<void>;
  onDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
  onSetDefaultPersona: (personaId: string) => Promise<void>;
}

export type PersonaFormData = {
  name: string;
  description: string;
  pronouns: string | null;
  pfSubjective: string;
  pfObjective: string;
  pfPossessive: string;
  pfPossessivePronoun: string;
  pfReflexive: string;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  avatarPreview: string | null;
};


// Empty baseline for the persona edit form. Kept at module scope so the
// reference is stable across renders (matters for the `values` prop on
// useForm — a new object literal each render would re-reset the form).
const EMPTY_PERSONA_FORM: PersonaFormData = {
  name: "",
  description: "",
  pronouns: null,
  pfSubjective: "",
  pfObjective: "",
  pfPossessive: "",
  pfPossessivePronoun: "",
  pfReflexive: "",
  avatarAssetId: null,
  avatarFullAssetId: null,
  avatarCropJson: null,
  avatarPreview: null,
};

/** F10 — dirty-state check for the controlled persona form.
 *  react-hook-form's `formState.isDirty` is unreliable here because the form
 *  is fully controlled (value={watch} + onChange=setValue, no `register`):
 *  per RHF docs, isDirty compares current values against a baseline and
 *  setValue on unregistered fields doesn't update it predictably. Instead we
 *  snapshot the values the form was reset to (startEdit / create-new) into
 *  `baselineRef` and compare the live values against it. Pure function so it
 *  can be unit-tested without a DOM. */
export function computePersonaIsDirty(
  current: PersonaFormData | null | undefined,
  baseline: PersonaFormData | null,
): boolean {
  if (!baseline) return false;
  if (!current) return false;
  return JSON.stringify(current) !== JSON.stringify(baseline);
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
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; error: string } | null>(null);
  const isMobile = useIsMobile();
  const stImport = useStPersonaImport({ isOpen });
  // ── Avatar crop modal state ──
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);

  // F10 — the form is fully controlled (value={watch} + onChange=setValue, no
  // `register`), so react-hook-form's `formState.isDirty` can't reliably
  // track edits: per RHF docs, isDirty compares current values against a
  // baseline, and setValue on unregistered fields doesn't update it
  // predictably (verified against RHF docs via context7). Rather than rely
  // on the `values`-prop / `register` quirks for a controlled form that also
  // does async avatar edits, compute isDirty directly: keep a snapshot of
  // the values the form was reset to (startEdit / create-new), and compare
  // the live values against it. `form.watch()` with no args subscribes to
  // every field so this recomputes on any edit. */}
  const baselineRef = useRef<PersonaFormData | null>(null);

  const form = useForm<PersonaFormData>({
    defaultValues: EMPTY_PERSONA_FORM,
  });

  if (!isOpen) return null;

  const isEditing = editingId !== null;
  const isLastPersona = input.personas.length <= 1;

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    setSelectedId(persona.id);
    const PRESET_KEYS = ["he/him", "she/her", "they/them", "it/its"];
    const isPreset = PRESET_KEYS.includes(persona.pronouns ?? "");
    // 'custom' discriminator OR a legacy free-text string (non-preset, non-empty)
    // both select the custom branch. Legacy free-text is seeded into the
    // subjective field so nothing is silently dropped.
    const isCustom = !isPreset && !!persona.pronouns && persona.pronouns !== "";
    const forms = persona.pronounForms;
    const next = {
      name: persona.name,
      description: persona.description,
      pronouns: isPreset ? (persona.pronouns ?? "") : isCustom ? "custom" : "",
      pfSubjective: forms?.subjective ?? (isCustom && !forms ? (persona.pronouns ?? "") : ""),
      pfObjective: forms?.objective ?? "",
      pfPossessive: forms?.possessive ?? "",
      pfPossessivePronoun: forms?.possessivePronoun ?? "",
      pfReflexive: forms?.reflexive ?? "",
      avatarAssetId: persona.avatarAssetId,
      avatarFullAssetId: null,
      avatarCropJson: null,
      avatarPreview: null,
    };
    form.reset(next);
    baselineRef.current = next;
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
    const avatarAssetId = form.getValues("avatarAssetId");
    const avatarFullAssetId = form.getValues("avatarFullAssetId");
    const avatarCropJson = form.getValues("avatarCropJson");
    if (!name.trim()) return;
    // Custom: build structured forms from the 5 fields. If every field is blank,
    // treat as 'no pronouns' (pronouns=null, pronounForms=null) rather than an
    // empty custom block. Preset: leave pronounForms null, write the preset key.
    let resolvedPronouns: string | null;
    let resolvedForms: PronounForms | null = null;
    if (pronouns === "custom") {
      const forms: PronounForms = {
        subjective: form.getValues("pfSubjective").trim(),
        objective: form.getValues("pfObjective").trim(),
        possessive: form.getValues("pfPossessive").trim(),
        possessivePronoun: form.getValues("pfPossessivePronoun").trim(),
        reflexive: form.getValues("pfReflexive").trim(),
      };
      const hasAny = forms.subjective || forms.objective || forms.possessive || forms.possessivePronoun || forms.reflexive;
      if (hasAny) {
        resolvedForms = forms;
        resolvedPronouns = "custom";
      } else {
        resolvedPronouns = null;
      }
    } else {
      resolvedPronouns = pronouns || null;
    }
    input.onSaveEdit(editingId, { name: name.trim(), description, pronouns: resolvedPronouns, pronounForms: resolvedForms, avatarAssetId, avatarFullAssetId });
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

  const editAvatarAssetId = form.watch("avatarAssetId");
  const editAvatarPreview = form.watch("avatarPreview");

  const editingPersona = input.personas.find(p => p.id === editingId) ?? null;
  const editDisplayAvatar = editAvatarPreview
    ?? (editingId ? resolveEntityAvatarUrl({ kind: "personas", id: editingId, avatarExt: editingPersona?.avatarExt ?? null, avatarAssetId: editAvatarAssetId, updatedAt: editingPersona?.updatedAt ?? null }) : null);
  const editAvatarCropJson = form.watch("avatarCropJson");

  // F10 — isDirty computed against the snapshot captured at startEdit /
  // create-new (see baselineRef above). `form.watch()` with no args subscribes
  // to every field, so this recomputes on any edit regardless of which field
  // changed — no reliance on RHF's register/dirtyFields internals, which
  // don't reliably track this fully-controlled (no-register) form.
  const allFormValues = form.watch();
  const isDirty = computePersonaIsDirty(allFormValues, baselineRef.current);
  const { containerRef: scrollBodyRef, cardRef: handleCardRef } = useRevealOnCreate(createdDraftPersonaId, isDirty);

  // Avatar-in-prompt fields live OUT-OF-BAND on the persona (excluded from
  // this modal's react-hook-form, same design as the character side — see
  // vibe_tavern_plan/reports/avatar-description-ui-gap.md). Commit via the
  // persona PATCH action; refresh the bootstrap list (the source of truth for
  // PersonaListItem) so the field re-renders with the persisted value.
  const handlePersonaAvatarPatch = (patch: AvatarDescriptionPatch) => {
    if (!editingId) return;
    void updatePersonaAction({ personaId: editingId, patch }).then(() => { void fetchPersonasAction(); });
  };
  const handlePersonaAvatarDescribe = async (signal: AbortSignal): Promise<void> => {
    if (!editingId) return;
    const { description } = await describePersonaAvatar(editingId, signal);
    // Backend persisted avatarDescription out-of-band. Mirror into the active
    // snapshot persona IF this persona is the active one (safe, sanctioned
    // ingest); always refresh the bootstrap list (source of truth for the list).
    const cur = useSnapshotStore.getState().persona;
    if (cur && cur.id === editingId) {
      useSnapshotStore.getState().ingestSnapshot({ persona: { ...cur, avatarDescription: description } });
    }
    void fetchPersonasAction();
  };

  // ── Card rendering ──
  const renderCard = (persona: PersonaListItem) => {
    const isActive = input.activePersonaId === persona.id;
    const editingThis = editingId === persona.id;
    const avatar = resolveEntityAvatarUrl({ kind: "personas", id: persona.id, avatarExt: persona.avatarExt, avatarAssetId: persona.avatarAssetId, updatedAt: persona.updatedAt });

    return (
      <div
        key={persona.id}
        ref={(el) => handleCardRef(persona.id, el)}
        className={cn(
          "group flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all duration-200",
          isMobile ? "active:bg-s2" : "hover:bg-s2",
          isActive && !isEditing ? "border-accent bg-accent-dim" : "border-transparent",
        )}
        onClick={() => { if (!isEditing) input.onSetActive(persona.id); }}
      >
        {editingThis ? (
          /* ── EDITING ── */
          <PersonaCardEditor
            persona={persona}
            form={form}
            isDirty={isDirty}
            isSaving={input.isSaving}
            avatarUploading={avatarUploading}
            avatarDisplayUrl={editDisplayAvatar}
            isMobile={isMobile}
            onSave={commitEdit}
            onCancel={cancelEdit}
            onAvatarSelected={(file) => setPendingAvatar({ file, url: URL.createObjectURL(file) })}
            onAvatarPatch={handlePersonaAvatarPatch}
            onAvatarDescribe={handlePersonaAvatarDescribe}
          />
        ) : (
          <PersonaCardCollapsed
            persona={persona}
            isActive={isActive}
            avatar={avatar}
            isLastPersona={isLastPersona}
            isMobile={isMobile}
            menuOpenId={menuOpenId}
            setMenuOpenId={setMenuOpenId}
            onStartEdit={() => startEdit(persona)}
            onExport={() => { exportPersona(persona.id, "st").catch((err) => toast.error(err instanceof Error ? err.message : t("persona_export_failed"))); }}
            onDuplicate={() => { void input.onDuplicatePersona(persona.id); }}
            onSetDefault={() => { if (!persona.defaultForNewChats) void input.onSetDefaultPersona(persona.id); }}
            onDelete={() => { handleDelete(persona.id); }}
          />
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
      {/* Mobile ActionSheet — persona actions (Export/Copy/Delete). Mirrors the
          character rail's three-dots bottom sheet (Rail.tsx). Desktop uses
          inline icon buttons instead, so this is mobile-only. */}
      {isMobile && menuOpenId && (() => {
        const active = input.personas.find((p) => p.id === menuOpenId);
        const items: ActionSheetItem[] = [
          { icon: <Icons.download />, label: t("persona_export"), action: async () => {
            const id = menuOpenId;
            setMenuOpenId(null);
            try { await exportPersona(id, "st"); }
            catch (err) { toast.error(err instanceof Error ? err.message : t("persona_export_failed")); }
          }},
          { icon: <Icons.Copy />, label: t("duplicate"), action: () => {
            const id = menuOpenId;
            setMenuOpenId(null);
            void input.onDuplicatePersona(id);
          }},
        ];
        if (!isLastPersona) {
          items.push({ icon: <Icons.del />, label: t("delete"), danger: true, action: () => {
            const id = menuOpenId;
            setMenuOpenId(null);
            handleDelete(id);
          }});
        }
        return (
          <ActionSheet
            open={true}
            title={active?.name ?? ""}
            items={items}
            onClose={() => setMenuOpenId(null)}
          />
        );
      })()}
      {/* Delete confirm */}
      {deleteConfirm && (
        <DestructiveConfirmModal
          title={t("delete_persona_title")}
          body={
            <>
              {t("delete_persona_body", { name: input.personas.find((p) => p.id === deleteConfirm.id)?.name ?? "Untitled" })}
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
      <div ref={scrollBodyRef} className={cn("flex-1 overflow-y-auto", isMobile ? "px-4 py-2" : "p-5")}>
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
      <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "flex-wrap px-4 py-3" : "px-5 py-3.5")}>
        <div
          className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] w-full basis-full text-[14px]" : "flex-1 py-2.5 text-sm")}
          style={{ color: "var(--t2)" }}
          onClick={async () => {
            discardCreatedDraft();
            const created = await input.onCreatePersona({ name: t("new_persona_default"), description: "" });
            if (created) {
              setCreatedDraftPersonaId(created.id);
              setSelectedId(created.id);
              setEditingId(created.id);
              const next = {
                name: t("new_persona_default"),
                description: "",
                pronouns: "",
                pfSubjective: "",
                pfObjective: "",
                pfPossessive: "",
                pfPossessivePronoun: "",
                pfReflexive: "",
                avatarAssetId: null,
                avatarFullAssetId: null,
                avatarCropJson: null,
                avatarPreview: null,
              };
              form.reset(next);
              baselineRef.current = next;
            }
          }}
        >
          <Icons.Plus /> {t("create_new_persona")}
        </div>
        {stImport.triggers}
      </div>
      {stImport.preview}
      {stImport.hiddenInputs}
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
