import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import type { PronounForms } from "@vibe-tavern/domain";
import { Icons } from "../shared/icons.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { AvatarCropModal } from "../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../shared/AvatarCropModal.js";
import { MasterDetailModal, MasterDetailFooter, MasterDetailMobileDrillDown } from "../shared/MasterDetailModal.js";
import { SaveButton } from "../shared/SaveBar.js";
import { PersonaListRow } from "./PersonaListRow.js";
import { PersonaCardEditor } from "./PersonaCardEditor.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useStPersonaImport } from "../../hooks/use-st-persona-import.js";
import { useRevealOnCreate } from "../../hooks/use-reveal-on-create.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

import { uploadPersonaAvatar, exportPersona } from "../../app-client.js";
import { promoteSourceAsFull } from "../build/editors/thumbnail-crop.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { toast } from "sonner";
import { fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { updatePersonaAction } from "../../stores/api-actions/persona-actions.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { describePersonaAvatar } from "../../api/gallery-api.js";
import type { AvatarDescriptionPatch } from "../build/editors/AvatarDescriptionField.js";

export interface PersonaListItem {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  pronounForms: PronounForms | null;
  avatarAssetId: string | null;
  avatarExt: string | null;
  // Full-size avatar fields from the wire PersonaRecord (the bootstrap store
  // passes PersonaRecord[] straight through). Surfaced for the D-1
  // "adjust thumbnail" flow: preferFull resolution + hasSeparateFull gate.
  avatarFullAssetId: string | null;
  avatarFullExt: string | null;
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
 *  snapshot the values the form was reset to (seedForm / create-new) into
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

/**
 * PersonaModal — persona manager on the shared MasterDetailModal shell
 * (PSM-1 port; mirrors the PromptManagerModal presets canon). Master column:
 * persona preview cards; row click activates the persona AND seeds the detail
 * editor in one gesture. Detail pane: the always-on editor (PersonaCardEditor;
 * the footer owns Save). Selection state (`selectedId`) IS the edited persona —
 * there is no separate editing flag anymore.
 */
export function PersonaModal(input: PersonaModalProps) {
  const { t } = useT();
  const isOpen = useModalStore((s) => s.isPersonaModalOpen);
  const setIsOpen = useModalStore((s) => s.setIsPersonaModalOpen);
  const onClose = () => {
    void discardCreatedDraft();
    setIsOpen(false);
  };
  // Canon dirty-close guard (PromptManagerModal handleClose): overlay click,
  // the header X, and the footer Close all funnel through here. A dirty draft
  // asks first; confirm and plain close both end in onClose (which discards
  // a created draft).
  const handleClose = () => {
    if (isDirty) setConfirmCloseOpen(true);
    else onClose();
  };
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [createdDraftPersonaId, setCreatedDraftPersonaId] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; error: string } | null>(null);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const isMobile = useIsMobile();
  const stImport = useStPersonaImport({ isOpen });
  // ── Avatar crop modal state ──
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);
  // D-1 "adjust thumbnail" crop mode: non-null while the second AvatarCropModal
  // is open on the EXISTING avatar (full endpoint), cloned from CharacterForm.
  const [thumbnailEditSrc, setThumbnailEditSrc] = useState<string | null>(null);

  // F10 — the form is fully controlled (value={watch} + onChange=setValue, no
  // `register`), so react-hook-form's `formState.isDirty` can't reliably
  // track edits: per RHF docs, isDirty compares current values against a
  // baseline, and setValue on unregistered fields doesn't update it
  // predictably (verified against RHF docs via context7). Rather than rely
  // on the `values`-prop / `register` quirks for a controlled form that also
  // does async avatar edits, compute isDirty directly: keep a snapshot of
  // the values the form was reset to (seedForm / create-new), and compare
  // the live values against it. `form.watch()` with no args subscribes to
  // every field so this recomputes on any edit regardless of which field
  // changed — no reliance on RHF's register/dirtyFields internals, which
  // don't reliably track this fully-controlled (no-register) form.
  const baselineRef = useRef<PersonaFormData | null>(null);

  const form = useForm<PersonaFormData>({
    defaultValues: EMPTY_PERSONA_FORM,
  });

  const isLastPersona = input.personas.length <= 1;

  function seedForm(persona: PersonaListItem): void {
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

  // Open-seed + null-fill. The form starts empty (EMPTY_PERSONA_FORM), so on
  // fresh open the detail pane would show blanks until the first row click —
  // seed it with the selected (else active, else first) persona instead.
  // Afterwards only nulls are filled (create-before-list, post-delete), so
  // in-progress edits are never clobbered.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      prevOpenRef.current = false;
      return;
    }
    if (input.personas.length === 0) {
      prevOpenRef.current = true;
      return;
    }
    if (!prevOpenRef.current) {
      prevOpenRef.current = true;
      const target = input.personas.find((p) => p.id === selectedId)
        ?? input.personas.find((p) => p.id === input.activePersonaId)
        ?? input.personas[0];
      if (target) seedForm(target);
      return;
    }
    if (selectedId !== null) return;
    const fallback = input.personas.find((p) => p.id === input.activePersonaId) ?? input.personas[0];
    if (fallback) seedForm(fallback);
    // seedForm intentionally excluded: stable logic over stable form/setter
    // refs; re-running on every render would defeat the null-only guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedId, input.personas, input.activePersonaId]);

  function discardCreatedDraft(): void {
    const draftId = createdDraftPersonaId;
    if (!draftId) return;
    setCreatedDraftPersonaId(null);
    // Clear the selection; the null-fill effect re-seeds the active (or
    // first) persona on the next render.
    setSelectedId((current) => current === draftId ? null : current);
    void input.onDeletePersona(draftId).catch(() => undefined);
  }

  function commitEdit(): void {
    if (!selectedId) return;
    const name = form.getValues("name");
    const description = form.getValues("description");
    const pronouns = form.getValues("pronouns");
    const avatarAssetId = form.getValues("avatarAssetId");
    const avatarFullAssetId = form.getValues("avatarFullAssetId");
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
    input.onSaveEdit(selectedId, { name: name.trim(), description, pronouns: resolvedPronouns, pronounForms: resolvedForms, avatarAssetId, avatarFullAssetId });
    if (createdDraftPersonaId === selectedId) setCreatedDraftPersonaId(null);
    // The editor stays mounted on the saved persona (no unmount-on-save in
    // master-detail): re-baseline to the saved values so Save flips back to
    // idle. Name is trimmed on save — mirror the trim into the form first so
    // the baseline comparison sees the same string further edits build on.
    form.setValue("name", name.trim());
    baselineRef.current = { ...form.getValues() };
  }

  function handleAvatarCropConfirm(result: AvatarCropResult): void {
    if (!selectedId) return;
    const targetId = selectedId;
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
  const footerName = form.watch("name");

  const selectedPersona = input.personas.find(p => p.id === selectedId) ?? null;
  // The editor slot is a LARGE display slot (character-card parity, D-1): it
  // renders the uncropped full when one exists (preferFull); /avatar/full
  // falls back to the thumbnail server-side for single-image personas.
  const editDisplayAvatar = editAvatarPreview
    ?? (selectedId ? resolveEntityAvatarUrl({ kind: "personas", id: selectedId, avatarExt: selectedPersona?.avatarExt ?? null, avatarAssetId: editAvatarAssetId, avatarFullExt: selectedPersona?.avatarFullExt ?? null, avatarFullAssetId: selectedPersona?.avatarFullAssetId ?? null, updatedAt: selectedPersona?.updatedAt ?? null, preferFull: true }) : null);

  // D-1: "adjust thumbnail" flow (CharacterForm portrait-branch clone). Opens
  // the cropper on the EXISTING avatar via the full endpoint so the square
  // 512×512 thumbnail can be re-framed; the original is NOT re-uploaded —
  // uploadPersonaAvatar(id, crop) with no `full` arg leaves avatar-full.{ext}
  // untouched, so this editor (a large, preferFull slot) keeps the uncropped
  // source.
  const handleOpenThumbnailCrop = (): void => {
    const persona = selectedPersona;
    if (!persona) return;
    const src = resolveEntityAvatarUrl({
      kind: "personas",
      id: persona.id,
      avatarExt: persona.avatarExt,
      avatarAssetId: persona.avatarAssetId,
      avatarFullExt: persona.avatarFullExt,
      avatarFullAssetId: persona.avatarFullAssetId,
      updatedAt: persona.updatedAt,
      preferFull: true,
    });
    if (src) setThumbnailEditSrc(src);
  };
  const handleThumbnailCropConfirm = async (result: AvatarCropResult): Promise<void> => {
    if (!selectedId) return;
    // Capture the cropper source BEFORE closing it. For a SINGLE-IMAGE persona
    // (avatarExt set, avatarFullExt null) that source is the only copy of the
    // uncropped original — /avatar/full falls back to serving avatar.{ext}, so
    // writing the crop without preserving it would snap every preferFull slot
    // (this editor) to the crop. promoteSourceAsFull returns the source as a
    // File iff no separate full exists, promoting the original to
    // avatar-full.{ext} in the same upload; undefined ⇒ crop-only write.
    // Same helper as the character side (thumbnail-crop.ts).
    const sourceUrl = thumbnailEditSrc;
    setThumbnailEditSrc(null);
    setAvatarUploading(true);
    try {
      const fullFile = await promoteSourceAsFull({
        sourceUrl,
        hasSeparateFull: !!selectedPersona?.avatarFullExt,
      });
      // No local avatarPreview here: the editor renders the full image,
      // unchanged by a thumbnail crop — a cropped preview would visibly snap
      // back after the list refresh. The new thumbnail surfaces in small
      // slots (list rows, sidebar) via fetchPersonasAction.
      await uploadPersonaAvatar(selectedId, result.croppedFile, fullFile);
      // Mirror handleAvatarCropConfirm: the backend cleared the legacy asset
      // ids (folder-resident now); null them so a later Save won't re-send
      // stale legacy ids through PATCH.
      form.setValue("avatarAssetId", null, { shouldDirty: true });
      form.setValue("avatarFullAssetId", null, { shouldDirty: true });
      await fetchPersonasAction();
    } catch (err) {
      // Nothing was optimistically previewed, so there is nothing to roll
      // back — log and leave the persisted avatar untouched.
      console.warn("[PersonaModal] thumbnail crop upload failed", err);
    } finally {
      setAvatarUploading(false);
    }
  };

  // F10 — isDirty computed against the snapshot captured at seedForm /
  // create-new (see baselineRef above). `form.watch()` with no args subscribes
  // to every field, so this recomputes on any edit regardless of which field
  // changed — no reliance on RHF's register/dirtyFields internals, which
  // don't reliably track this fully-controlled (no-register) form.
  const allFormValues = form.watch();
  const isDirty = computePersonaIsDirty(allFormValues, baselineRef.current);
  const { containerRef: scrollBodyRef, cardRef: handleCardRef } = useRevealOnCreate(createdDraftPersonaId, isDirty);

  // PersonaModal stays mounted in AppShell while closed. Every hook above must
  // run on both closed and open renders; returning before useRevealOnCreate
  // changed the hook count on first open and triggered React error #310.
  if (!isOpen) return null;

  // Avatar-in-prompt fields live OUT-OF-BAND on the persona (excluded from
  // this modal's react-hook-form, same design as the character side — see
  // vibe_tavern_plan/reports/avatar-description-ui-gap.md). Commit via the
  // persona PATCH action; refresh the bootstrap list (the source of truth for
  // PersonaListItem) so the field re-renders with the persisted value.
  const handlePersonaAvatarPatch = (patch: AvatarDescriptionPatch) => {
    if (!selectedId) return;
    void updatePersonaAction({ personaId: selectedId, patch }).then(() => { void fetchPersonasAction(); });
  };
  const handlePersonaAvatarDescribe = async (signal: AbortSignal): Promise<void> => {
    if (!selectedId) return;
    const { description } = await describePersonaAvatar(selectedId, signal);
    // Backend persisted avatarDescription out-of-band. Mirror into the active
    // snapshot persona IF this persona is the active one (safe, sanctioned
    // ingest); always refresh the bootstrap list (source of truth for the list).
    const cur = useSnapshotStore.getState().persona;
    if (cur && cur.id === selectedId) {
      useSnapshotStore.getState().ingestSnapshot({ persona: { ...cur, avatarDescription: description } });
    }
    void fetchPersonasAction();
  };

  // ── Master row rendering: canon list-row chrome (border-l-2 accent +
  // drill-down caret); content is the messenger-layout preview row. Wave 4:
  // the row itself only SELECTS for viewing/editing (seedForm) — activation
  // is explicit via the row's "use for chat" button (ProviderViewHeader
  // make-active pattern, rendered by PersonaListRow).
  const renderRow = (persona: PersonaListItem, openDetail: () => void) => {
    const isSelected = selectedId === persona.id;
    const avatar = resolveEntityAvatarUrl({ kind: "personas", id: persona.id, avatarExt: persona.avatarExt, avatarAssetId: persona.avatarAssetId, updatedAt: persona.updatedAt });
    const select = () => {
      seedForm(persona);
    };
    const activate = () => {
      input.onSetActive(persona.id);
      seedForm(persona);
    };

    return (
      <div
        key={persona.id}
        ref={(el) => handleCardRef(persona.id, el)}
        className={cn(
          "group flex cursor-pointer items-start gap-2 border-l-2 px-3 py-3 transition-colors",
          isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
        )}
        onClick={() => {
          select();
          if (isMobile) openDetail();
        }}
      >
        <PersonaListRow
          persona={persona}
          isActive={input.activePersonaId === persona.id}
          avatar={avatar}
          isMobile={isMobile}
          onSetDefault={() => { if (!persona.defaultForNewChats) void input.onSetDefaultPersona(persona.id); }}
          onSelectForChat={activate}
        />
        <MasterDetailMobileDrillDown onSelect={select} className="self-center" />
      </div>
    );
  };

  async function handleCreate(): Promise<void> {
    discardCreatedDraft();
    const created = await input.onCreatePersona({ name: t("new_persona_default"), description: "" });
    if (created) {
      setCreatedDraftPersonaId(created.id);
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
      // The created row may not be in `input.personas` until the parent
      // refreshes the bootstrap list: select by id now (the null-fill effect
      // would otherwise grab a different row), reset the blank form, and
      // baseline it. Once the list arrives, detailContent finds the persona.
      setSelectedId(created.id);
      form.reset(next);
      baselineRef.current = next;
    }
  }

  return (
    <>
      <MasterDetailModal
        isOpen={isOpen}
        onClose={handleClose}
        title={t("persona_manager_title")}
        subtitle={t("persona_manager_sub")}
        detailTitle={selectedPersona ? selectedPersona.name : t("persona_manager_title")}
        dirty={isDirty}
        masterClassName="flex w-[380px] shrink-0 flex-col border-r border-border"
        masterContent={({ openDetail }) => (
          <>
            <div ref={scrollBodyRef} className="min-h-0 flex-1 overflow-y-auto py-2">
              {input.personas.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 text-t4"><Icons.User /></div>
                  <div className="font-ui text-[14px] font-medium text-t2">{t("no_personas")}</div>
                  <div className="font-ui text-[12px] text-t3 mt-1">{t("create_first_persona")}</div>
                </div>
              )}
              <div className="flex flex-col">
                {input.personas.map((p) => renderRow(p, openDetail))}
              </div>
            </div>
            {/* ST import preview panel — inline slot between the list and the
                dock (same relative position as the old footer-adjacent slot).
                Margin tuning (mx-5) is PSM-2 polish if it looks off here. */}
            {stImport.preview}
            {/* "+ New" dock + ST-import trigger, mirroring PresetList's dashed
                new/import dock under border-t. The grid wrapper stretches the
                trigger button full-width (canon: stacked full-width buttons). */}
            <div className="shrink-0 border-t border-border px-3 py-3">
              <button
                type="button"
                onClick={() => { void handleCreate(); }}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
              >
                <Icons.Plus /> {t("create_new_persona")}
              </button>
              <div className="mt-2 grid gap-2">{stImport.triggers}</div>
            </div>
            {stImport.hiddenInputs}
          </>
        )}
        detailContent={selectedPersona ? (
          <PersonaCardEditor
            persona={selectedPersona}
            form={form}
            isSaving={input.isSaving}
            avatarUploading={avatarUploading}
            avatarDisplayUrl={editDisplayAvatar}
            isMobile={isMobile}
            onAvatarSelected={(file) => setPendingAvatar({ file, url: URL.createObjectURL(file) })}
            onAvatarPatch={handlePersonaAvatarPatch}
            onAvatarDescribe={handlePersonaAvatarDescribe}
            onOpenThumbnailCrop={handleOpenThumbnailCrop}
          />
        ) : input.personas.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 text-t4"><Icons.User /></div>
            <div className="font-ui text-[14px] font-medium text-t2">{t("no_personas")}</div>
            <div className="font-ui text-[12px] text-t3 mt-1">{t("create_first_persona")}</div>
          </div>
        ) : null}
        footer={
          <MasterDetailFooter
            actions={
              selectedPersona
                ? [
                    { icon: <Icons.Copy />, label: t("duplicate"), onClick: () => { void input.onDuplicatePersona(selectedPersona.id); } },
                    { icon: <Icons.download />, label: t("persona_export"), onClick: () => { exportPersona(selectedPersona.id, "st").catch((err) => toast.error(err instanceof Error ? err.message : t("persona_export_failed"))); } },
                    // Last-persona guard (mirrors the presets footer): the
                    // Delete action is omitted, not disabled, when only one
                    // persona exists. handleDelete keeps its own error path.
                    ...(isLastPersona
                      ? []
                      : [{ icon: <Icons.del />, label: t("delete"), onClick: () => handleDelete(selectedPersona.id) } as const]),
                  ]
                : []
            }
            onClose={handleClose}
            right={
              <SaveButton
                dirty={isDirty}
                saveState={input.isSaving ? "saving" : "idle"}
                resetKey={selectedId}
                disabled={input.isSaving || !(footerName || "").trim()}
                label={t("save_btn")}
                onClick={commitEdit}
              />
            }
          />
        }
      />
      {/* Avatar crop modal */}
      {pendingAvatar && (
        <AvatarCropModal
          imageUrl={pendingAvatar.url}
          onConfirm={handleAvatarCropConfirm}
          onCancel={handleAvatarCropCancel}
        />
      )}
      {/* D-1 "adjust thumbnail" crop — opens on the existing avatar (full
          endpoint); confirm re-frames the 512×512 thumbnail only. */}
      {thumbnailEditSrc && (
        <AvatarCropModal
          imageUrl={thumbnailEditSrc}
          fileName="persona_avatar.png"
          onConfirm={handleThumbnailCropConfirm}
          onCancel={() => setThumbnailEditSrc(null)}
        />
      )}
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
      {/* Dirty-close guard (canon: ConfirmCloseModal, same as PromptManager). */}
      {confirmCloseOpen && (
        <ConfirmCloseModal
          onCancel={() => setConfirmCloseOpen(false)}
          onConfirm={() => {
            setConfirmCloseOpen(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
