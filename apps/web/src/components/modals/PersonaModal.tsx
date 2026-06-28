import { useState, useRef, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import type { PronounForms } from "@vibe-tavern/domain";
import { Icons } from "../shared/icons.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ActionSheet, type ActionSheetItem } from "../shared/ActionSheet.js";
import { BoundResourcesField } from "../shared/BoundResourcesField.js";
import { AvatarCropModal } from "../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../shared/AvatarCropModal.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { Checkbox } from "../shared/Checkbox.js";
import { Modal } from "../shared/Modal.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

import { createPersona, uploadPersonaAvatar, exportPersona } from "../../app-client.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { parseStPersonas, type StPersonaEntry } from "../../lib/st-persona-parser.js";
import { toast } from "sonner";
import { fetchBootstrapAction, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { updatePersonaAction } from "../../stores/api-actions/persona-actions.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { describePersonaAvatar } from "../../api/gallery-api.js";
import { AvatarDescriptionField, type AvatarDescriptionPatch } from "../build/editors/AvatarDescriptionField.js";

interface PersonaListItem {
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

type PersonaFormData = {
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


function PersonaTokenBadge({ text }: { text: string }) {
  const { t } = useT();
  const count = useTokenCount(text);
  return <span className="font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} {t("tokens_label")}</span>;
}

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
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; error: string } | null>(null);
  const isMobile = useIsMobile();

  // ── ST persona import state ──
  const [stImportPreview, setStImportPreview] = useState<StPersonaEntry[] | null>(null);
  // PR-9: defer enabling the import tooltip until after the modal opening
  // animation/settling. Radix Dialog.Content auto-focuses on open, and the
  // global TooltipProvider has a short delayDuration — together they caused
  // the tooltip to flash on modal mount. We enable the tooltip only after a
  // short delay, so it opens on genuine hover/focus but never on mount.
  const [importTooltipReady, setImportTooltipReady] = useState(false);
  useEffect(() => {
    if (!isOpen) { setImportTooltipReady(false); return; }
    const t = setTimeout(() => setImportTooltipReady(true), 400);
    return () => clearTimeout(t);
  }, [isOpen]);

  // PR-11: auto-scroll to a newly created persona.
  //
  // WHY NOT scrollIntoView / rAF: the new card mounts collapsed, then
  // transitions to the expanded edit form (setEditingId fires in the same
  // click). The edit form's AutoTextarea auto-resizes via useLayoutEffect, so
  // the card's height is NOT final when the ref callback (or its rAF) runs.
  // A one-shot scrollIntoView caches its target pixel against the stale
  // (short) height and under-scrolls — the user sees the new card cut off
  // near the footer when starting from scrollTop 0.
  //
  // FIX: ResizeObserver on the new card. Since the new persona is always the
  // LAST list item (backend listAll has no ORDER BY → rowid/insertion order),
  // "reveal it" == "pin the scroll container to its bottom". The observer
  // re-pins on every height change (collapsed→expanded, avatar load, typing),
  // so the destination is always computed against the CURRENT card height.
  // Disconnects when the draft id changes or the card unmounts.
  //
  // NOT the MessageList rAF bottom-pinning pattern — that is a different
  // concern (live message append during streaming); this is a static list.
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const createdCardObserver = useRef<ResizeObserver | null>(null);
  const handleCardRef = useCallback((personaId: string, el: HTMLDivElement | null) => {
    if (el) {
      cardRefs.current.set(personaId, el);
      if (personaId === createdDraftPersonaId) {
        // Start observing this card's size; each change pins the list to its
        // bottom, which always reveals the last item (the new persona).
        createdCardObserver.current?.disconnect();
        const body = scrollBodyRef.current;
        const ro = new ResizeObserver(() => {
          if (!body) return;
          body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
        });
        ro.observe(el);
        createdCardObserver.current = ro;
      }
    } else {
      cardRefs.current.delete(personaId);
      if (personaId === createdDraftPersonaId) {
        createdCardObserver.current?.disconnect();
        createdCardObserver.current = null;
      }
    }
  }, [createdDraftPersonaId]);
  // Disconnect the observer when the created-draft id changes (new creation,
  // discard, or save) or the modal unmounts.
  useEffect(() => {
    return () => {
      createdCardObserver.current?.disconnect();
      createdCardObserver.current = null;
    };
  }, [createdDraftPersonaId]);
  const [stImportSelected, setStImportSelected] = useState<Set<string>>(new Set());
  const [stImporting, setStImporting] = useState(false);
  const [stImportProgress, setStImportProgress] = useState<{ current: number; total: number } | null>(null);
  const stFolderRef = useRef<HTMLInputElement>(null);
  const stFileRef = useRef<HTMLInputElement>(null);
  const stAvatarFiles = useRef<Map<string, File>>(new Map());

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

  // Single .json file import — accepts either ST backup/export shape
  // (top-level personas, what exportPersona('st') emits) or a raw ST
  // settings.json (power_user.*). No avatars (they live as separate PNGs in
  // ST's folder layout, not embedded in the JSON) — personas import bare.
  async function handleStFilePick(files?: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const entries = parseStPersonas(parsed);
      if (entries.length === 0) {
        toast.error(t("st_no_personas_found"));
        return;
      }
      stAvatarFiles.current = new Map();
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

  const editName = form.watch("name");
  const editDescription = form.watch("description");
  const editPronouns = form.watch("pronouns");
  const editPfSubjective = form.watch("pfSubjective");
  const editPfObjective = form.watch("pfObjective");
  const editPfPossessive = form.watch("pfPossessive");
  const editPfPossessivePronoun = form.watch("pfPossessivePronoun");
  const editPfReflexive = form.watch("pfReflexive");
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

  const PRONOUN_OPTIONS: { v: string; l: string }[] = [
    { v: "", l: t("pronouns_none") },
    { v: "he/him", l: "he/him" },
    { v: "she/her", l: "she/her" },
    { v: "they/them", l: "they/them" },
    { v: "it/its", l: "it/its" },
    { v: "custom", l: t("pronouns_custom") },
  ];

  // Five-field declension descriptors for the custom-pronoun form (PR-7).
  // Placeholder uses the he/him example for each slot.
  const PRONOUN_FORM_FIELDS: { key: "pfSubjective" | "pfObjective" | "pfPossessive" | "pfPossessivePronoun" | "pfReflexive"; label: string; placeholder: string; value: string }[] = [
    { key: "pfSubjective", label: t("pronoun_field_subjective"), placeholder: "he", value: editPfSubjective },
    { key: "pfObjective", label: t("pronoun_field_objective"), placeholder: "him", value: editPfObjective },
    { key: "pfPossessive", label: t("pronoun_field_possessive"), placeholder: "his", value: editPfPossessive },
    { key: "pfPossessivePronoun", label: t("pronoun_field_possessive_pronoun"), placeholder: "his", value: editPfPossessivePronoun },
    { key: "pfReflexive", label: t("pronoun_field_reflexive"), placeholder: "himself", value: editPfReflexive },
  ];

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
                  <div className={cn("mt-2 grid gap-1.5", isMobile ? "grid-cols-1" : "grid-cols-2")}>
                    {PRONOUN_FORM_FIELDS.map((f) => (
                      <label key={f.key} className="block">
                        <span className="mb-0.5 block font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{f.label}</span>
                        <input
                          className="w-full rounded border border-border bg-s2 py-1.5 px-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none focus:border-accent"
                          value={f.value}
                          onChange={(e) => form.setValue(f.key, e.target.value, { shouldDirty: true })}
                          placeholder={f.placeholder}
                        />
                      </label>
                    ))}
                  </div>
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
            {/* Bound lorebooks — reverse-direction binding (PR-12). Shown only
                in the edit form (requires a persisted personaId). Scripts are
                tracked separately — see script-link-binding-gap.md. */}
            {editingId && (
              <BoundResourcesField entityKind="persona" entityId={editingId} isMobile={isMobile} />
            )}
            {/* Avatar-in-prompt — describe via vision + toggle + description.
                Out-of-band from this modal's form (see handlePersonaAvatarPatch). */}
            {editingId && editingPersona && (
              <div className="mb-3">
                <AvatarDescriptionField
                  kind="persona"
                  includeAvatarInPrompt={editingPersona.includeAvatarInPrompt}
                  avatarDescription={editingPersona.avatarDescription}
                  hasAvatar={!!(editingPersona.avatarAssetId || editDisplayAvatar)}
                  onPatch={handlePersonaAvatarPatch}
                  onDescribe={handlePersonaAvatarDescribe}
                  disabled={input.isSaving}
                />
              </div>
            )}
            {/* Save / Cancel */}
            <div className="flex gap-2">
              <button type="button"
                className="min-h-[40px] cursor-pointer rounded-md bg-accent px-4 font-ui text-sm font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:hover:brightness-100"
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
            {/* Avatar + default-persona star (PR-8) */}
            <div className="flex shrink-0 flex-col items-center gap-1">
              <div className="relative">
                <div
                  className={cn(
                    "flex items-center justify-center overflow-hidden rounded-full text-base shadow-inner ring-1 ring-white/5",
                    isMobile ? "h-[68px] w-[68px]" : "h-[88px] w-[88px] text-lg",
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
                <CustomTooltip content={persona.defaultForNewChats ? t("default_persona_is") : t("set_default_persona")}>
                  <button
                    type="button"
                    aria-label={t("set_default_persona")}
                    className={cn(
                      "absolute -right-1 -bottom-1 z-10 flex items-center justify-center rounded-full border border-border bg-surface transition-all hover:scale-110",
                      isMobile ? "h-6 w-6" : "h-6 w-6",
                      persona.defaultForNewChats ? "text-accent" : "text-t4 hover:text-accent",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!persona.defaultForNewChats) void input.onSetDefaultPersona(persona.id);
                    }}
                  >
                    <Icons.Star />
                  </button>
                </CustomTooltip>
              </div>
              {isMobile && persona.defaultForNewChats && (
                <span className="font-ui text-[10px] text-t3">{t("persona_default_label")}</span>
              )}
            </div>
            {/* Info */}
            <div className="min-w-0 flex-1 overflow-hidden py-0.5">
              <div className="flex items-center gap-2">
                <div className="font-ui text-[15px] font-semibold tracking-tight text-t1">{persona.name}</div>
              </div>
              {(() => {
                // For the 'custom' discriminator, show a compact subjective/objective
                // label derived from the structured forms (e.g. "ze/zir") instead of
                // the literal word "custom".
                if (persona.pronouns === "custom" && persona.pronounForms) {
                  const f = persona.pronounForms;
                  return <div className="font-ui text-[13px] text-t3">{f.subjective}/{f.objective}</div>;
                }
                if (persona.pronouns && persona.pronouns !== "custom") {
                  return <div className="font-ui text-[13px] text-t3">{persona.pronouns}</div>;
                }
                return null;
              })()}
              <div className={cn("font-ui text-[13px] leading-snug text-t3", isMobile ? "line-clamp-2" : "line-clamp-3")}>{persona.description}</div>
              <PersonaTokenBadge text={persona.description} />
            </div>
            {/* Actions — PR-10 revised:
                Desktop: all 4 buttons (Edit/Export/Copy/Delete) inline, visible on card hover.
                Mobile: Edit stays as a direct inline button (primary action); Export/Copy/Delete collapse into a three-dots menu (row too narrow for 4 inline buttons). */}
            <div className="relative flex shrink-0 items-start gap-0.5 self-start">
              <CustomTooltip content={t("persona_edit")}>
                <div
                  className={cn(
                    "flex cursor-pointer items-center justify-center rounded-md text-t3 transition-all hover:bg-s2 hover:text-t1 active:bg-s3",
                    isMobile ? "min-h-[44px] min-w-[44px]" : "h-7 w-7",
                    // Desktop: hidden until the card is hovered. Mobile: always visible.
                    !isMobile && "opacity-0 group-hover:opacity-100",
                  )}
                  onClick={(e) => { e.stopPropagation(); startEdit(persona); }}
                >
                  <Icons.Edit />
                </div>
              </CustomTooltip>

              {!isMobile ? (
                /* Desktop: direct inline icon buttons */
                <>
                  <CustomTooltip content={t("persona_export")}>
                    <div
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 opacity-0 transition-all hover:bg-s2 hover:text-t1 active:bg-s3 group-hover:opacity-100"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try { await exportPersona(persona.id, "st"); }
                        catch (err) { toast.error(err instanceof Error ? err.message : t("persona_export_failed")); }
                      }}
                    >
                      <Icons.download />
                    </div>
                  </CustomTooltip>
                  <CustomTooltip content={t("duplicate")}>
                    <div
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 opacity-0 transition-all hover:bg-s2 hover:text-t1 active:bg-s3 group-hover:opacity-100"
                      onClick={(e) => { e.stopPropagation(); void input.onDuplicatePersona(persona.id); }}
                    >
                      <Icons.Copy />
                    </div>
                  </CustomTooltip>
                  <CustomTooltip content={t("delete")}>
                    <div
                      className={cn(
                        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-all active:bg-s3 opacity-0 group-hover:opacity-100",
                        isLastPersona ? "text-t4" : "text-t3 hover:bg-s2 hover:text-danger",
                      )}
                      onClick={(e) => { e.stopPropagation(); handleDelete(persona.id); }}
                    >
                      <Icons.del />
                    </div>
                  </CustomTooltip>
                </>
              ) : (
                /* Mobile: Edit stays inline; Export/Copy/Delete in a bottom ActionSheet (reuses the same component the character rail uses). */
                <>
                  <div
                    className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3"
                    onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === persona.id ? null : persona.id); }}
                  >
                    <Icons.ellipsis />
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
        {importTooltipReady ? (
          <CustomTooltip content={t("st_persona_import_hint")}>
            <button type="button"
              className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-4 text-sm")}
              style={{ color: "var(--t2)" }}
              onClick={() => stFileRef.current?.click()}
            >
              <Icons.Import /> {t("st_import_personas_btn")}
            </button>
          </CustomTooltip>
        ) : (
          <button type="button"
            className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-4 text-sm")}
            style={{ color: "var(--t2)" }}
            onClick={() => stFileRef.current?.click()}
          >
            <Icons.Import /> {t("st_import_personas_btn")}
          </button>
        )}
        <CustomTooltip content={t("st_folder_import_hint")}>
          <button type="button"
            className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-3 text-sm")}
            style={{ color: "var(--t2)" }}
            onClick={() => stFolderRef.current?.click()}
          >
            <Icons.Import /> {t("st_folder_import_btn")}
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
      {/* Hidden single-file input — accepts a .json backup/export (VT-exported
          ST shape or raw ST settings.json). No avatars. */}
      <input
        ref={stFileRef}
        className="hidden"
        type="file"
        accept="application/json,.json"
        onChange={(e) => void handleStFilePick(e.target.files)}
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
