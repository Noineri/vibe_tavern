import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { toast } from "sonner";
import type {
  ImagePromptFamiliesValue,
  ImagePromptFamilyInfoValue,
  ImagePromptFamilyValue,
  ImagePromptProfileDetailResponse,
  ImagePromptProfileListResponse,
  ImagePromptProfileValue,
  ImagePromptTemplateCellValue,
  ImagePromptTemplateRowKeyValue,
  CreateImagePromptProfileRequest,
  UpdateImagePromptProfileRequest,
} from "@vibe-tavern/api-contracts";
import { IMAGE_GENERATION_MODES } from "@vibe-tavern/domain";
import {
  createImagePromptProfile,
  deleteImagePromptProfile,
  getImagePromptProfileDetail,
  listImagePromptProfiles,
  reorderImagePromptProfiles,
  setActiveImagePromptProfile,
  updateImagePromptProfile,
} from "../../../api/image-prompt-profile-api.js";
import { listImagePromptFamilies } from "../../../api/image-gen-api.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { codeQuoteCls, lblCls, listHeaderCls, rowTitleCls } from "../../../lib/field-tokens.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { Icons } from "../../shared/icons.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { MasterDetailFooter } from "../../shared/MasterDetailModal.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { TextInput } from "../../shared/text-input.js";
import { Toggle } from "../../shared/Toggle.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { ASSIST_CORE_KEY, ImagePromptAssistRow, savedAssistEntry } from "./image-prompt-assist-row.js";
import {
  normalizeDraftCell,
  overridesEqual,
  toWireOverrides,
  type DraftCell,
  type DraftOverrides,
} from "./image-prompt-draft.js";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * The Images tab of the prompt manager, rebuilt on separately-living image
 * prompt profiles (IF-1d — IMAGEGEN_FOLLOWUP_REPORT). A deliberate fork of
 * `ServicePromptsPane` (same profile machinery: read-only Default + copies,
 * create/rename/duplicate/delete/reorder, click = select + make live,
 * whole-profile save with a discard guard) with the field model swapped to
 * the IPT detail side: each mode row carries its own family `DropdownSelect`
 * (decision-6: a per-mode family dropdown, e.g. scene generation → Pony —
 * see reports/IMAGE_PROMPT_TEMPLATES_RESEARCH.md) and opens the
 * template editor + quality layer inside an AnimatedDisclosure. The assist
 * row (ImagePromptAssistRow, fork #1 of the row chrome below) edits the
 * extraction core (`assist|prose`, one per profile) and the selected
 * family's addendum (`assist|<family>`) through the same whole-profile
 * save; Default stays a read-only canon view.
 */

export interface ImagePromptTemplatesPaneSlots {
  master: ReactNode;
  detail: ReactNode;
  footer: ReactNode;
  dirty: boolean;
}

/** Test seam — production uses the typed API clients; tests inject mocks. */
export interface ImagePromptTemplatesPaneApi {
  listProfiles: () => Promise<ImagePromptProfileListResponse>;
  getProfile: (id: string) => Promise<ImagePromptProfileDetailResponse | null>;
  create: (body: CreateImagePromptProfileRequest) => Promise<ImagePromptProfileValue>;
  update: (id: string, body: UpdateImagePromptProfileRequest) => Promise<ImagePromptProfileValue>;
  remove: (id: string) => Promise<void>;
  setActive: (profileId: string | null) => Promise<void>;
  reorder: (updates: Array<{ id: string; sortOrder: number }>) => Promise<ImagePromptProfileListResponse>;
  listFamilies: () => Promise<ImagePromptFamiliesValue>;
}

const defaultApi: ImagePromptTemplatesPaneApi = {
  listProfiles: listImagePromptProfiles,
  getProfile: getImagePromptProfileDetail,
  create: createImagePromptProfile,
  update: updateImagePromptProfile,
  remove: deleteImagePromptProfile,
  setActive: setActiveImagePromptProfile,
  reorder: reorderImagePromptProfiles,
  listFamilies: listImagePromptFamilies,
};

export type ImagePromptTemplatesPaneRowId = ImagePromptTemplateRowKeyValue | "assist";

type SelectedRow = { kind: "template"; rowKey: ImagePromptTemplateRowKeyValue } | { kind: "assist" };

const ROW_ORDER: readonly ImagePromptTemplateRowKeyValue[] = [...Object.values(IMAGE_GENERATION_MODES), "negative"];


function rowLabelKey(rowKey: ImagePromptTemplateRowKeyValue): string {
  return rowKey === "negative" ? "imagePromptTemplates.negative" : `image_gen_mode_${rowKey}`;
}

function familyLabelKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.family.${family}`;
}

function familyDetailKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.familyDetail.${family}`;
}

function rowIdFor(row: SelectedRow): ImagePromptTemplatesPaneRowId {
  return row.kind === "assist" ? "assist" : row.rowKey;
}


const SortableProfileRow = React.memo(
  ({
    profile,
    isActive,
    isSelected,
    onSelect,
    isMobile,
    onRenameStart,
    renderDrillDown,
  }: {
    profile: ImagePromptProfileValue;
    isActive: boolean;
    isSelected: boolean;
    onSelect: (id: string) => void;
    isMobile: boolean;
    onRenameStart: (id: string, name: string) => void;
    renderDrillDown?: (id: string, selectRow: () => void) => ReactNode;
  }) => {
    const { t } = useT();
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
      id: profile.id,
    });
    const style: CSSProperties = {
      transform: CSS.Translate.toString(transform),
      transition,
      ...(isDragging ? { opacity: 0 } : {}),
    };
    return (
      <div
        ref={setNodeRef}
        style={style}
        onClick={() => onSelect(profile.id)}
        data-testid={`image-prompt-profile-row-${profile.id}`}
        className={cn(
          "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[48px] px-3 sm:transition-colors touch-manipulation",
          isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
        )}
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="flex h-8 w-7 shrink-0 select-none items-center justify-center rounded cursor-grab touch-none text-t4 transition-colors hover:bg-s2 hover:text-t1 active:cursor-grabbing sm:h-auto sm:w-5"
        >
          <span className="text-[calc(var(--ui-fs)+2px)] leading-6 leading-none">≡</span>
        </button>
        <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isActive ? "bg-accent" : "bg-transparent")} />
        <CustomTooltip content={profile.name}>
          <span
            className={cn(
              rowTitleCls, "min-w-0 flex-1 truncate",
              isSelected ? "text-accent-t" : "text-t2",
            )}
          >
            {profile.name}
          </span>
        </CustomTooltip>
        <button
          type="button"
          aria-label={t("edit")}
          onClick={(e) => {
            e.stopPropagation();
            onRenameStart(profile.id, profile.name);
          }}
          className={cn(
            "shrink-0 rounded p-1 transition-colors",
            isMobile ? "text-t4" : "opacity-0 group-hover:opacity-100 text-t4 hover:bg-s3 hover:text-t1",
            isMobile && "ml-1",
          )}
        >
          <Icons.Edit />
        </button>
        {!isMobile && (
          <div className="ml-auto hidden md:flex">
            {renderDrillDown?.(profile.id, () => onSelect(profile.id))}
          </div>
        )}
        {isMobile && renderDrillDown?.(profile.id, () => onSelect(profile.id))}
      </div>
    );
  },
);

export function ImagePromptTemplatesPane({
  active,
  children,
  renderRowDrillDown,
  onDirtyChange,
  onClose,
  api = defaultApi,
}: {
  active: boolean;
  children: (slots: ImagePromptTemplatesPaneSlots) => ReactNode;
  /** Mobile master-detail seam over the PROFILE rows, matching ServicePromptsPane. */
  renderRowDrillDown?: (profileId: string, selectRow: () => void) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
  onClose?: () => void;
  /** Test seam: production uses the typed API clients above. */
  api?: ImagePromptTemplatesPaneApi;
}): ReactNode {
  const { t, tDynamic } = useT();
  const isMobile = useIsMobile();
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [profiles, setProfiles] = useState<ImagePromptProfileValue[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [detail, setDetail] = useState<ImagePromptProfileDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailErrorKey, setDetailErrorKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftOverrides, setDraftOverrides] = useState<DraftOverrides>({});
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [families, setFamilies] = useState<ImagePromptFamilyInfoValue[]>([]);
  const [selectedFamilies, setSelectedFamilies] = useState<Partial<Record<ImagePromptTemplatesPaneRowId, ImagePromptFamilyValue>>>({});
  const [expandedRows, setExpandedRows] = useState<Partial<Record<ImagePromptTemplatesPaneRowId, boolean>>>({});
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);
  useEffect(() => {
    if (isCreating) newInputRef.current?.focus();
  }, [isCreating]);

  const isDefaultSelected = detail?.profile.isDefault ?? false;

  const dirty = useMemo(() => {
    if (!detail) return false;
    if (draftName !== detail.profile.name) return true;
    const saved: DraftOverrides = {};
    for (const [key, cell] of Object.entries(detail.profile.overrides)) {
      if (cell) saved[key] = normalizeDraftCell(cell);
    }
    return !overridesEqual(draftOverrides, saved);
  }, [detail, draftName, draftOverrides]);

  useEffect(() => {
    onDirtyChange?.(active && dirty);
  }, [active, dirty, onDirtyChange]);

  const defaultProfile = useMemo(() => profiles.find((p) => p.isDefault) ?? null, [profiles]);
  const nonDefaultProfiles = useMemo(() => profiles.filter((p) => !p.isDefault), [profiles]);

  const {
    displayItems: displayNonDefault,
    sensors,
    activeDragItem,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<ImagePromptProfileValue>({
    items: nonDefaultProfiles,
    getId: (p) => p.id,
    onReorder: (activeId, overId, currentItems) => {
      const fromIdx = currentItems.findIndex((p) => p.id === activeId);
      const toIdx = currentItems.findIndex((p) => p.id === overId);
      if (fromIdx === -1 || toIdx === -1) {
        return { optimisticItems: currentItems, persist: () => {} };
      }
      const reordered = arrayMove(currentItems, fromIdx, toIdx);
      return {
        optimisticItems: reordered,
        persist: () => api.reorder(reordered.map((p, i) => ({ id: p.id, sortOrder: i }))).then((res) => {
          setProfiles(res.profiles);
          setActiveProfileId(res.activeProfileId);
        }),
      };
    },
  });

  const refreshList = useCallback(async () => {
    setLoadState("loading");
    try {
      const [res, familyResponse] = await Promise.all([api.listProfiles(), api.listFamilies()]);
      setProfiles(res.profiles);
      setActiveProfileId(res.activeProfileId);
      setFamilies(familyResponse.families);
      const firstFamily = familyResponse.families[0]?.id;
      if (firstFamily) {
        setSelectedFamilies((current) => {
          const next = { ...current };
          for (const rowId of [...ROW_ORDER, "assist"] as ImagePromptTemplatesPaneRowId[]) {
            next[rowId] ??= firstFamily;
          }
          return next;
        });
      }
      setLoadState("ready");
      if (!selectedId && res.profiles.length > 0) {
        const liveId = res.activeProfileId ?? res.profiles.find((p) => p.isDefault)?.id ?? res.profiles[0]!.id;
        setSelectedId(liveId);
      }
    } catch {
      setLoadState("error");
    }
  }, [api, selectedId]);

  useEffect(() => {
    if (!active) return;
    if (loadState === "idle") {
      void refreshList();
    }
  }, [active, loadState, refreshList]);

  useEffect(() => {
    if (!active) return;
    if (!selectedId) return;
    setDetailState("loading");
    setDetailErrorKey(null);
    let cancelled = false;
    void api.getProfile(selectedId)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setDetailState("error");
          setDetailErrorKey("imagePromptTemplates.loadError");
          return;
        }
        setDetail(res);
        setDraftName(res.profile.name);
        const draft: DraftOverrides = {};
        for (const [key, cell] of Object.entries(res.profile.overrides)) {
          if (cell) draft[key] = normalizeDraftCell(cell);
        }
        setDraftOverrides(draft);
        setDetailState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDetailState("error");
        setDetailErrorKey("imagePromptTemplates.loadError");
      });
    return () => {
      cancelled = true;
    };
  }, [active, selectedId, detailNonce, api]);

  const handleSetActive = useCallback(
    async (id: string, isDefault: boolean) => {
      const target = isDefault ? null : id;
      try {
        await api.setActive(target);
        setActiveProfileId(target);
      } catch {
        toast.error(tDynamic("imagePromptTemplates.profile.activateFailed"));
      }
    },
    [api, tDynamic],
  );

  const handleSelectRow = useCallback(
    (id: string) => {
      if (id === selectedId) {
        const p = profiles.find((pr) => pr.id === id);
        if (p) {
          const alreadyLive = (activeProfileId === null && p.isDefault) || activeProfileId === id;
          if (!alreadyLive) void handleSetActive(id, p.isDefault);
        }
        return;
      }
      if (dirty) {
        setPendingSelectId(id);
        return;
      }
      setSelectedId(id);
      const p = profiles.find((pr) => pr.id === id);
      if (p) void handleSetActive(id, p.isDefault);
    },
    [activeProfileId, dirty, handleSetActive, profiles, selectedId],
  );

  const confirmDiscard = useCallback(() => {
    if (pendingSelectId) {
      const id = pendingSelectId;
      setSelectedId(id);
      setPendingSelectId(null);
      const p = profiles.find((pr) => pr.id === id);
      if (p) void handleSetActive(id, p.isDefault);
    }
  }, [handleSetActive, pendingSelectId, profiles]);

  const handleRenameStart = useCallback((id: string, name: string) => {
    setRenamingId(id);
    setRenameValue(name);
  }, []);

  const handleRenameSave = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      const updated = await api.update(renamingId, { name: trimmed });
      setProfiles((prev) => prev.map((p) => (p.id === renamingId ? { ...p, name: updated.name } : p)));
      if (detail && detail.profile.id === renamingId) {
        setDetail({ ...detail, profile: { ...detail.profile, name: updated.name } });
      }
    } catch {
      toast.error(tDynamic("imagePromptTemplates.profile.renameFailed"));
    } finally {
      setRenamingId(null);
    }
  }, [api, detail, renamingId, renameValue, tDynamic]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.remove(id);
        const wasSelected = selectedId === id;
        const res = await api.listProfiles();
        setProfiles(res.profiles);
        setActiveProfileId(res.activeProfileId);
        setConfirmDeleteId(null);
        if (wasSelected) {
          const liveId = res.activeProfileId ?? res.profiles.find((p) => p.isDefault)?.id ?? res.profiles[0]?.id ?? null;
          setSelectedId(liveId);
        }
      } catch {
        setConfirmDeleteId(null);
        toast.error(tDynamic("imagePromptTemplates.profile.deleteFailed"));
      }
    },
    [api, selectedId, tDynamic],
  );

  const handleDuplicate = useCallback(
    async (profile: ImagePromptProfileValue) => {
      try {
        const dup = await api.create({
          name: `${profile.name} (copy)`,
          overrides: { ...profile.overrides },
        });
        const res = await api.listProfiles();
        setProfiles(res.profiles);
        await api.setActive(dup.id);
        setActiveProfileId(dup.id);
        setSelectedId(dup.id);
        setRenamingId(dup.id);
        setRenameValue(dup.name);
      } catch {
        toast.error(tDynamic("imagePromptTemplates.profile.duplicateFailed"));
      }
    },
    [api, tDynamic],
  );

  const handleCreateNew = useCallback(async () => {
    const name = newName.trim() || tDynamic("imagePromptTemplates.profile.newNamePlaceholder");
    try {
      const created = await api.create({ name, overrides: {} });
      const res = await api.listProfiles();
      setProfiles(res.profiles);
      await api.setActive(created.id);
      setActiveProfileId(created.id);
      setSelectedId(created.id);
      setIsCreating(false);
      setNewName("");
      setRenamingId(created.id);
      setRenameValue(created.name);
    } catch {
      setIsCreating(false);
      toast.error(tDynamic("imagePromptTemplates.profile.createFailed"));
    }
  }, [api, newName, tDynamic]);

  const handleSave = useCallback(async () => {
    if (!detail || isDefaultSelected || saving) return;
    setSaving(true);
    try {
      const updated = await api.update(detail.profile.id, {
        name: draftName.trim() || detail.profile.name,
        overrides: toWireOverrides(draftOverrides),
      });
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? { ...p, name: updated.name } : p)));
      setDetail({ ...detail, profile: updated });
    } catch {
      toast.error(tDynamic("imagePromptTemplates.profile.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [api, detail, draftName, draftOverrides, isDefaultSelected, saving, tDynamic]);

  // ─── Detail-side cell helpers ─────────────────────────────────────────────

  const cellFor = useCallback(
    (rowKey: ImagePromptTemplateRowKeyValue, family: ImagePromptFamilyValue): ImagePromptTemplateCellValue | null => {
      if (!detail) return null;
      return detail.catalog.cells.find((cell) => cell.rowKey === rowKey && cell.family === family) ?? null;
    },
    [detail],
  );

  const setCellDraft = useCallback((rowKey: ImagePromptTemplateRowKeyValue, family: ImagePromptFamilyValue, patch: DraftCell) => {
    setDraftOverrides((prev) => ({ ...prev, [`${rowKey}|${family}`]: patch }));
  }, []);

  const resetCellDraft = useCallback((rowKey: ImagePromptTemplateRowKeyValue, family: ImagePromptFamilyValue) => {
    setDraftOverrides((prev) => {
      const next = { ...prev };
      delete next[`${rowKey}|${family}`];
      return next;
    });
  }, []);


  const toggleRow = useCallback((rowId: ImagePromptTemplatesPaneRowId) => {
    setExpandedRows((prev) => ({ ...prev, [rowId]: !prev[rowId] }));
  }, []);

  const familyOptions = useMemo(
    () => families.map((family) => ({
      id: family.id,
      label: tDynamic(familyLabelKey(family.id)),
      detail: tDynamic(familyDetailKey(family.id)),
    })),
    [families, tDynamic],
  );

  /** SC-8e — the assist row's selected family (the addendum editor follows
   *  the row's own family selector; the core is family-independent). */
  const assistFamily = selectedFamilies.assist ?? families[0]?.id;

  const footerActions = useMemo(() => {
    if (!detail) return [];
    if (isDefaultSelected) {
      return [{ icon: <Icons.Copy />, label: t("imagePromptTemplates.profile.duplicateButton"), onClick: () => void handleDuplicate(detail.profile) }];
    }
    return [
      { icon: <Icons.Copy />, label: t("imagePromptTemplates.profile.duplicateButton"), onClick: () => void handleDuplicate(detail.profile) },
      { icon: <Icons.Trash />, label: t("delete"), onClick: () => setConfirmDeleteId(detail.profile.id) },
    ];
  }, [detail, handleDuplicate, isDefaultSelected, t]);

  if (!active) {
    return children({ master: null, detail: null, footer: null, dirty: false });
  }

  // ─── Master: the profile list (ServicePromptsPane fork) ───────────────────

  const master = (
    <div className="flex flex-1 flex-col min-h-0 py-2.5">
      <div className="shrink-0 px-[13px]">
        <div className={cn(listHeaderCls, "pb-[5px] pt-1")}>
          {t("imagePromptTemplates.profile.masterTitle")}
        </div>
      </div>
      {loadState === "loading" && (
        <div className="px-4 py-6 font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("loading")}</div>
      )}
      {loadState === "error" && (
        <div className="px-4 py-4">
          <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-danger">{t("imagePromptTemplates.loadError")}</div>
          <button
            type="button"
            onClick={() => void refreshList()}
            className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s3"
          >
            {t("retry")}
          </button>
        </div>
      )}
      {loadState === "ready" && (
        <div className="flex-1 overflow-y-auto">
          {defaultProfile && (() => {
            const p = defaultProfile;
            const isSelected = selectedId === p.id;
            const isActive = activeProfileId === null;
            const isRenaming = renamingId === p.id;
            return (
              <div
                key={p.id}
                data-testid={`image-prompt-profile-row-${p.id}`}
                onClick={() => handleSelectRow(p.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[48px] px-3 sm:transition-colors",
                  isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
                )}
              >
                <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isActive ? "bg-accent" : "bg-transparent")} />
                <CustomTooltip content={t("promptManager.servicePrompts.liveTooltip")}>
                  <span className="flex shrink-0 text-t3">
                    <Icons.Lock />
                  </span>
                </CustomTooltip>
                {isRenaming ? (
                  <InlineRenameInput
                    ref={renameInputRef}
                    className="min-w-0 flex-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleRenameSave();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void handleRenameSave()}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <CustomTooltip content={p.name}>
                    <span
                      className={cn(
                        rowTitleCls, "min-w-0 flex-1 truncate",
                        isSelected ? "text-accent-t" : "text-t2",
                      )}
                    >
                      {p.name}
                      <span className="ml-1.5 rounded bg-success/15 px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-4px)] text-success">
                        {t("promptManager.servicePrompts.liveBadge")}
                      </span>
                    </span>
                  </CustomTooltip>
                )}
                {!isRenaming && (
                  <button
                    type="button"
                    aria-label={t("edit")}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameStart(p.id, p.name);
                    }}
                    className={cn(
                      "shrink-0 rounded p-1 transition-colors",
                      isMobile ? "text-t4" : "opacity-0 group-hover:opacity-100 text-t4 hover:bg-s3 hover:text-t1",
                    )}
                  >
                    <Icons.Edit />
                  </button>
                )}
                {renderRowDrillDown?.(p.id, () => handleSelectRow(p.id))}
              </div>
            );
          })()}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
            <SortableContext items={displayNonDefault.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              {displayNonDefault.map((p) => {
                const isSelected = selectedId === p.id;
                const isActive = activeProfileId === p.id;
                const isRenaming = renamingId === p.id;
                if (isRenaming) {
                  return (
                    <div key={p.id} className="border-l-2 border-transparent px-3 py-2">
                      <InlineRenameInput
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRenameSave();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => void handleRenameSave()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  );
                }
                return (
                  <SortableProfileRow
                    key={p.id}
                    profile={p}
                    isActive={isActive}
                    isSelected={isSelected}
                    onSelect={handleSelectRow}
                    isMobile={isMobile}
                    onRenameStart={handleRenameStart}
                    renderDrillDown={renderRowDrillDown}
                  />
                );
              })}
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeDragItem ? (
                <div className={cn("flex items-center gap-2 border-l-2 min-h-[48px] px-3", activeDragItem.id === selectedId ? "border-l-accent bg-accent-dim" : "border-l-transparent bg-s2")}>
                  <span className="text-[calc(var(--ui-fs)+2px)] leading-6 leading-none text-t4">≡</span>
                  <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", activeDragItem.id === activeProfileId ? "bg-accent" : "bg-transparent")} />
                  <span className={cn(rowTitleCls, "truncate text-t1")}>{activeDragItem.name}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
          {isCreating && (
            <div className="border-l-2 border-transparent px-3 py-2">
              <InlineRenameInput
                ref={newInputRef}
                placeholder={t("imagePromptTemplates.profile.newNamePlaceholder")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateNew();
                  if (e.key === "Escape") {
                    setIsCreating(false);
                    setNewName("");
                  }
                }}
                onBlur={() => {
                  if (!newName.trim()) setIsCreating(false);
                  else void handleCreateNew();
                }}
              />
            </div>
          )}
        </div>
      )}
      {loadState === "ready" && (
        <div className="shrink-0 border-t border-border px-3 pt-3">
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:border-border hover:bg-s2 hover:text-t1"
          >
            <Icons.Plus />
            {t("promptManager.servicePrompts.newProfile")}
          </button>
        </div>
      )}
      {confirmDeleteId && (
        <DestructiveConfirmModal
          title={t("imagePromptTemplates.profile.deleteTitle")}
          body={t("imagePromptTemplates.profile.deleteBody")}
          confirmLabel={t("delete")}
          onConfirm={() => void handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
      {pendingSelectId && (
        <DestructiveConfirmModal
          title={t("promptManager.servicePrompts.discardTitle")}
          body={t("promptManager.servicePrompts.discardBody")}
          confirmLabel={t("confirm")}
          onConfirm={confirmDiscard}
          onCancel={() => setPendingSelectId(null)}
        />
      )}
    </div>
  );

  // ─── Detail: mode rows × family dropdown + editor (IPT side, kept) ───────
  // forks: 1 — the assist row lives in image-prompt-assist-row.tsx (fork #1,
  // SC-8e ratchet split; the section/disclosure/dropdown chrome there mirrors
  // this function's row chrome).

  const renderRowDisclosure = (rowKey: ImagePromptTemplateRowKeyValue, label: string) => {
    const rowId: ImagePromptTemplatesPaneRowId = rowKey;
    const family = selectedFamilies[rowId] ?? families[0]?.id;
    const cell = family ? cellFor(rowKey, family) : null;
    const isOpen = expandedRows[rowId] ?? false;
    const draftKey = family ? `${rowId}|${family}` : null;
    const draftCell = draftKey ? draftOverrides[draftKey] : undefined;
    const isCustomized = draftCell !== undefined;
    const familyInfo = family ? families.find((f) => f.id === family) : undefined;
    const qualityCanon = family ? detail?.catalog.qualityCanon[family] : undefined;
    const hasQualityLayer = cell !== null && cell.rowKey !== "negative" && familyInfo?.ownQuality === true && qualityCanon !== undefined;
    return (
      <section key={rowId} data-testid={`image-prompt-template-row-${rowId}`} className="flex flex-col rounded-md border border-border">
        <div className="flex min-w-0 items-center gap-1.5 px-3 py-2.5">
          {/* The toggle bleeds over the wrapper's padding (-ml/-my restores the
              same text position via pl/py), so the ENTIRE row surface — not a
              narrow content-height band — is the disclosure's hit area. */}
          <button
            type="button"
            onClick={() => toggleRow(rowId)}
            disabled={saving}
            className="-ml-3 -my-2.5 flex min-w-0 flex-1 items-center gap-1.5 py-2.5 pl-3 text-left"
          >
            <span className={cn("min-w-0 flex-shrink font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isCustomized ? "text-accent-t" : "text-t2")}>{label}</span>
            <span
              data-testid={`image-prompt-template-status-${rowId}`}
              role="img"
              aria-label={t(isCustomized ? "imagePromptTemplates.status.custom" : "imagePromptTemplates.status.canon")}
              className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isCustomized ? "bg-accent" : "bg-t4")}
            />
            <span className="ml-auto flex shrink-0 text-t4">
              <Icons.Caret direction={isOpen ? "u" : "d"} />
            </span>
          </button>
          {family && (
            <DropdownSelect
              value={family}
              options={familyOptions}
              onChange={(next) => {
                setSelectedFamilies((current) => ({ ...current, [rowId]: next as ImagePromptFamilyValue }));
              }}
              disabled={saving}
              searchable={false}
              triggerDetail={false}
              contentWidth={300}
              triggerTestId={`image-prompt-template-family-${rowId}`}
              triggerClassName="h-7 w-auto max-w-[136px] rounded border border-border bg-s2 px-2 py-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 hover:border-accent"
            />
          )}
        </div>
        <AnimatedDisclosure open={isOpen}>
          <div className="flex flex-col gap-4 px-3 pb-3">
            {cell && !isDefaultSelected && (
              <>
                <AutoTextarea
                  mono
                  value={draftCell?.body ?? cell.customText ?? cell.canonText}
                  onChange={(event) => draftKey && setCellDraft(rowKey, family!, {
                    body: event.target.value,
                    qualityText: draftCell?.qualityText ?? (cell.qualityText ?? null),
                  })}
                  disabled={saving}
                  minRows={8}
                  maxRows={24}
                  aria-label={t("imagePromptTemplates.editorLabel")}
                />
                <div className="flex items-center justify-end gap-2">
                  {isCustomized && (
                    <button
                      type="button"
                      onClick={() => draftKey && family && resetCellDraft(rowKey, family)}
                      disabled={saving}
                      className="h-7 cursor-pointer rounded-md border border-border bg-transparent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-50"
                    >
                      {t("reset")}
                    </button>
                  )}
                </div>
                {hasQualityLayer && (
                  <section className="flex flex-col gap-3 rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className={cn(lblCls, "!mb-0")}>{t("imagePromptTemplates.qualityLayer")}</div>
                        <div className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("imagePromptTemplates.qualityLayerHint")}</div>
                      </div>
                      <Toggle
                        checked={(draftCell?.qualityText ?? cell.qualityText) !== null}
                        onChange={(next) => draftKey && family && setCellDraft(rowKey, family, {
                          body: draftCell?.body ?? cell.customText ?? cell.canonText,
                          qualityText: next ? draftCell?.qualityText ?? cell.qualityText ?? qualityCanon ?? null : null,
                        })}
                        disabled={saving}
                        aria-label={t("imagePromptTemplates.customQualityToggle")}
                      />
                    </div>
                    <div>
                      <div className={lblCls}>{t("imagePromptTemplates.qualityCanon")}</div>
                      <div data-testid="image-prompt-template-quality-canon" className={cn(codeQuoteCls, "max-h-40 overflow-auto")}>{qualityCanon}</div>
                    </div>
                    {(draftCell?.qualityText ?? cell.qualityText) !== null && (
                      <div>
                        <div className={lblCls}>{t("imagePromptTemplates.customQuality")}</div>
                        <AutoTextarea
                          mono
                          value={draftCell?.qualityText ?? cell.qualityText ?? qualityCanon ?? ""}
                          onChange={(event) => draftKey && family && setCellDraft(rowKey, family, {
                            body: draftCell?.body ?? cell.customText ?? cell.canonText,
                            qualityText: event.target.value,
                          })}
                          disabled={saving}
                          minRows={3}
                          maxRows={10}
                          aria-label={t("imagePromptTemplates.customQualityEditorLabel")}
                        />
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
            {cell && isDefaultSelected && (
              <>
                <div className={cn(codeQuoteCls, "max-h-40 overflow-auto")}>{cell.customText ?? cell.canonText}</div>
                {hasQualityLayer && (
                  <div>
                    <div className={lblCls}>{t("imagePromptTemplates.qualityCanon")}</div>
                    <div data-testid="image-prompt-template-quality-canon" className={cn(codeQuoteCls, "max-h-40 overflow-auto")}>{qualityCanon}</div>
                  </div>
                )}
              </>
            )}
          </div>
        </AnimatedDisclosure>
      </section>
    );
  };

  const detailNode = (
    <div className="flex flex-col gap-4">
      {detailState === "loading" && <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("loading")}</div>}
      {detailState === "error" && (
        <div>
          <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-danger">{tDynamic(detailErrorKey ?? "imagePromptTemplates.loadError")}</div>
          <button
            type="button"
            onClick={() => setDetailNonce((n) => n + 1)}
            className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s3"
          >
            {t("retry")}
          </button>
        </div>
      )}
      {detailState === "ready" && detail && (
        <>
          {!isDefaultSelected && (
            <label className={lblCls}>
              {t("imagePromptTemplates.profile.profileName")}
              <TextInput
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                disabled={saving}
                aria-label={t("imagePromptTemplates.profile.profileName")}
              />
            </label>
          )}
          {isDefaultSelected && (
            <div className="rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t2">
              <span className="font-medium text-t1">{detail.profile.name}</span>
              <span className="ml-2 text-t3">{t("imagePromptTemplates.profile.defaultReadOnlyHint")}</span>
            </div>
          )}
          {ROW_ORDER.map((rowKey) => renderRowDisclosure(rowKey, tDynamic(rowLabelKey(rowKey))))}
          <ImagePromptAssistRow
            label={t("imagePromptTemplates.assist")}
            expanded={expandedRows.assist ?? false}
            onToggle={() => toggleRow("assist")}
            saving={saving}
            readOnly={isDefaultSelected}
            family={assistFamily}
            familyOptions={familyOptions}
            onFamilySelect={(nextFamily) => setSelectedFamilies((current) => ({ ...current, assist: nextFamily }))}
            detail={detail}
            getDraftBody={(partFamily) => {
              const key = partFamily === null ? ASSIST_CORE_KEY : `assist|${partFamily}`;
              return draftOverrides[key]?.body ?? null;
            }}
            writeDraft={(apply) => setDraftOverrides((prev) => apply(prev))}
          />
        </>
      )}
    </div>
  );

  const footer = (
    <MasterDetailFooter
      actions={detailState === "ready" && detail ? footerActions : []}
      onClose={onClose}
      right={
        detailState === "ready" && detail && !isDefaultSelected ? (
          <SaveButton dirty={dirty} saveState={saving ? "saving" : "idle"} onClick={() => void handleSave()} label={t("save_btn")} resetKey={detail.profile.id} />
        ) : undefined
      }
    />
  );

  return children({ master, detail: detailNode, footer, dirty: active && dirty });
}
