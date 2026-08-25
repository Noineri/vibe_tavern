import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { MasterDetailMobileDrillDown } from "../../shared/MasterDetailModal.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { buildFlatVisualOrder, interpretRegexDrop, type FlatItem } from "../../../lib/regex-profile-drop.js";

type RegexPresetRef = {
  id: string;
  name: string;
  disabled: boolean;
  notApplied: "disabled" | "unbound" | null;
  profileId?: string | null;
  shadowed?: boolean;
  sortOrder?: number;
};

type RegexProfileRef = {
  id: string;
  name: string;
  disabled: boolean;
  notApplied: "disabled" | "unbound" | null;
  sortOrder: number;
  memberCount: number;
};

interface RegexPresetListProps {
  presets: RegexPresetRef[];
  profiles?: RegexProfileRef[];
  activePresetId: string | null;
  activeProfileId?: string | null;
  expandedProfileIds?: string[];
  onSelect: (id: string) => void;
  onSelectProfile?: (id: string) => void;
  onAdd: (name: string) => void;
  onAddProfile?: (name: string) => void;
  onAddRuleToProfile?: (profileId: string, name: string) => void;
  onRename: (id: string, newName: string) => void;
  onRenameProfile?: (id: string, newName: string) => void;
  onCopy: (id: string) => void;
  onExport: (id: string) => void;
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onReorderProfiles?: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onAttach?: (profileId: string, ruleId: string) => void | Promise<unknown>;
  onDetach?: (ruleId: string) => void | Promise<unknown>;
  onToggleProfile?: (id: string) => void;
  onImportRegex?: () => void;
}

const SortableRegexPresetRow = React.memo(({ p, isActive, onSelect, isMobile, startEditing, onCopy, onExport, dndDisabled }: {
  p: RegexPresetRef;
  isActive: boolean;
  onSelect: (id: string) => void;
  isMobile: boolean;
  startEditing: (preset: RegexPresetRef, e: React.MouseEvent) => void;
  onCopy: (id: string) => void;
  onExport: (id: string) => void;
  dndDisabled: boolean;
}) => {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: `rule:${p.id}`,
    disabled: dndDisabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0 } : {}),
  };
  const statusKey = p.notApplied === "disabled"
    ? "promptManager.regex.badgeDisabledReason"
    : p.notApplied === "unbound" ? "promptManager.regex.badgeUnboundReason"
    : "promptManager.regex.badgeWorking";
  const statusDotCls = p.notApplied === "disabled" ? "bg-t4"
    : p.notApplied === "unbound" ? "bg-danger"
    : "bg-success";
  const isMember = p.profileId != null;
  return (
    <div
      ref={setNodeRef}
      style={style}
      onPointerDown={() => onSelect(p.id)}
      className={cn(
        "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[56px] px-4 sm:transition-colors touch-manipulation",
        isMember && "ml-4 border-l border-border/50",
        isActive ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
        isMember && isActive && "border-l-accent"
      )}
    >
      {!dndDisabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-grab touch-none text-t4 transition-colors hover:text-t1 active:cursor-grabbing"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <div className={cn("h-[6px] w-[6px] shrink-0 rounded-full sm:transition-colors", isActive ? "bg-accent" : "bg-transparent")} />
      <CustomTooltip content={p.name}>
        <span className={cn(
          "truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium",
          isActive ? "text-accent-t" : "text-t2",
          p.disabled && "opacity-50",
        )}>{p.name}</span>
      </CustomTooltip>
      {p.shadowed && (
        <CustomTooltip content={t("promptManager.regex.memberShadowed")}>
          <span role="img" aria-label={t("promptManager.regex.memberShadowed")} className="flex shrink-0 p-1">
            <span className="h-[6px] w-[6px] rounded-full bg-danger" />
          </span>
        </CustomTooltip>
      )}
      <button type="button"
        onClick={(e) => startEditing(p, e)}
        className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
      ><Icons.Edit /></button>
      <CustomTooltip content={t("promptManager.regex.copy")}>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onCopy(p.id); }}
          aria-label={t("promptManager.regex.copy")}
          className={cn("shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Copy /></button>
      </CustomTooltip>
      <CustomTooltip content={t("promptManager.regex.export")}>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onExport(p.id); }}
          aria-label={t("promptManager.regex.export")}
          className={cn("shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Download /></button>
      </CustomTooltip>
      <div className="ml-auto flex items-center gap-1">
        <CustomTooltip content={t(statusKey)}>
          <span role="img" aria-label={t(statusKey)} className="flex shrink-0 p-1">
            <span className={cn("h-[6px] w-[6px] rounded-full", statusDotCls)} />
          </span>
        </CustomTooltip>
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
        <CustomTooltip content={t("promptManager.regex.copy")}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onCopy(p.id); }}
            aria-label={t("promptManager.regex.copy")}
            className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
          ><Icons.Copy /></button>
        </CustomTooltip>
        <CustomTooltip content={t("promptManager.regex.export")}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onExport(p.id); }}
            aria-label={t("promptManager.regex.export")}
            className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
          ><Icons.Download /></button>
        </CustomTooltip>
        <MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-1" />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isActive === next.isActive &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.p.disabled === next.p.disabled &&
  prev.p.notApplied === next.p.notApplied &&
  prev.p.profileId === next.p.profileId &&
  prev.p.shadowed === next.p.shadowed &&
  prev.dndDisabled === next.dndDisabled);

const SortableRegexProfileRow = React.memo(({ p, isActive, isExpanded, onSelect, isMobile, startEditing, dndDisabled, onToggle }: {
  p: RegexProfileRef;
  isActive: boolean;
  isExpanded: boolean;
  onSelect: (id: string) => void;
  isMobile: boolean;
  startEditing: (profile: RegexProfileRef, e: React.MouseEvent) => void;
  dndDisabled: boolean;
  onToggle: (id: string) => void;
}) => {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: `profile:${p.id}`,
    disabled: dndDisabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0 } : {}),
  };
  const statusKey = p.notApplied === "disabled"
    ? "promptManager.regex.badgeDisabledReason"
    : p.notApplied === "unbound" ? "promptManager.regex.badgeUnboundReason"
    : "promptManager.regex.badgeWorking";
  const statusDotCls = p.notApplied === "disabled" ? "bg-t4"
    : p.notApplied === "unbound" ? "bg-danger"
    : "bg-success";
  return (
    <div
      ref={setNodeRef}
      style={style}
      onPointerDown={() => onSelect(p.id)}
      className={cn(
        "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[56px] px-4 sm:transition-colors touch-manipulation bg-s1/50",
        isActive ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2"
      )}
    >
      {!dndDisabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-grab touch-none text-t4 transition-colors hover:text-t1 active:cursor-grabbing"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(p.id); }}
        aria-label={isExpanded ? t("promptManager.regex.collapseProfile") : t("promptManager.regex.expandProfile")}
        className="shrink-0 text-t3 hover:text-t1"
      >
        <Icons.Caret direction={isExpanded ? "d" : "r"} />
      </button>
      <CustomTooltip content={p.name}>
        <span className={cn(
          "truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium",
          isActive ? "text-accent-t" : "text-t1",
          p.disabled && "opacity-50",
        )}>{p.name}</span>
      </CustomTooltip>
      <span className="shrink-0 font-ui text-[11px] text-t4">({p.memberCount})</span>
      <button type="button"
        onClick={(e) => startEditing(p, e)}
        className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
      ><Icons.Edit /></button>
      <div className="ml-auto flex items-center gap-1">
        <CustomTooltip content={t(statusKey)}>
          <span role="img" aria-label={t(statusKey)} className="flex shrink-0 p-1">
            <span className={cn("h-[6px] w-[6px] rounded-full", statusDotCls)} />
          </span>
        </CustomTooltip>
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
        <MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-1" />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isActive === next.isActive &&
  prev.isExpanded === next.isExpanded &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.p.disabled === next.p.disabled &&
  prev.p.notApplied === next.p.notApplied &&
  prev.p.memberCount === next.p.memberCount &&
  prev.dndDisabled === next.dndDisabled);

export function RegexPresetList({ presets, profiles = [], activePresetId, activeProfileId, expandedProfileIds: controlledExpanded, onSelect, onSelectProfile, onAdd, onAddProfile, onAddRuleToProfile, onRename, onRenameProfile, onReorder, onReorderProfiles, onCopy, onExport, onAttach, onDetach, onToggleProfile, onImportRegex }: RegexPresetListProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set());
  const expandedIds = useMemo(() => {
    if (controlledExpanded) return new Set(controlledExpanded);
    return internalExpanded;
  }, [controlledExpanded, internalExpanded]);
  const [inlineRuleProfileId, setInlineRuleProfileId] = useState<string | null>(null);
  const [inlineRuleName, setInlineRuleName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingId || editingProfileId) editInputRef.current?.focus(); }, [editingId, editingProfileId]);
  useEffect(() => { if (isCreating || isCreatingProfile) newInputRef.current?.focus(); }, [isCreating, isCreatingProfile]);

  const dndDisabled = search.trim().length > 0;

  const flatItems: FlatItem[] = useMemo(() => {
    const effProfiles = profiles.map((pr) => ({ id: pr.id, sortOrder: pr.sortOrder, name: pr.name }));
    const effPresets = presets.map((p) => ({ id: p.id, sortOrder: p.sortOrder ?? 0, name: p.name, profileId: p.profileId ?? null }));
    // Preserve original sortOrder from presets where available: need actual sortOrder from presets prop
    // The presets prop's sortOrder is not in RegexPresetRef; we use 0 fallback but need real value
    // Instead, we will build based on the order of presets/profiles arrays which are already sorted by parent
    // For flat order we keep inference by array order when sortOrder not available, but we have it in parent state
    // For simplicity, use provided sortOrder from profiles, and for presets use index as fallback
    // The parent passes presets sorted; we keep that order via the flat visual builder's sort
    // To make tests deterministic, we trust the passed order: build using sortOrder 0 + name localeCompare
    // The actual flat order will be sorted; for drag tests we care about visual order as built
    return buildFlatVisualOrder(effProfiles, effPresets, expandedIds);
  }, [profiles, presets, expandedIds]);

  // For sortable ids, use flatItems sortableIds
  const sortableIds = useMemo(() => {
    // Exclude editing rows from sortable set
    const editingSortable = editingId ? `rule:${editingId}` : editingProfileId ? `profile:${editingProfileId}` : null;
    return flatItems.filter((f) => f.sortableId !== editingSortable).map((f) => f.sortableId);
  }, [flatItems, editingId, editingProfileId]);

  const handleToggle = (id: string) => {
    if (onToggleProfile) onToggleProfile(id);
    else setInternalExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Sensors and reorder handling via custom interpretation
  const {
    sensors,
    activeDragItem,
    handleDragStart: baseHandleDragStart,
    handleDragEnd: baseHandleDragEnd,
    handleDragCancel,
  } = useReorderableList<FlatItem>({
    items: flatItems,
    getId: (f) => f.sortableId,
    onReorder: (activeId, overId, currentFlat) => {
      const interpretation = interpretRegexDrop(currentFlat, activeId, overId);
      let optimistic = currentFlat;
      let persist: () => void | Promise<unknown> = () => {};
      if (interpretation.kind === "attach" && onAttach && interpretation.ruleId && interpretation.profileId) {
        const { ruleId, profileId } = interpretation;
        // optimistic: move rule into target profile's expanded members
        const activeIdx = currentFlat.findIndex((f) => f.sortableId === activeId);
        const overIdx = currentFlat.findIndex((f) => f.sortableId === overId);
        if (activeIdx !== -1 && overIdx !== -1) {
          const moved = arrayMove(currentFlat, activeIdx, overIdx);
          optimistic = moved.map((it) => it.sortableId === activeId ? { ...it, profileId } : it);
        }
        persist = () => {
          onAttach(profileId, ruleId);
          // R-13b fix: the optimistic move placed the rule at the drop spot,
          // but its stored sortOrder is from the top-level scale — without a
          // member-scale rewrite the refetched order snaps elsewhere. Persist
          // the target profile's member order (0-based within the group).
          if (onReorder) {
            const memberIds = optimistic
              .filter((f) => f.kind === "rule" && f.profileId === profileId)
              .map((f) => f.id);
            if (memberIds.length > 0) {
              void onReorder(memberIds.map((id, i) => ({ id, sortOrder: i })));
            }
          }
        };
      } else if (interpretation.kind === "detach" && onDetach && interpretation.ruleId) {
        const { ruleId } = interpretation;
        const activeIdx = currentFlat.findIndex((f) => f.sortableId === activeId);
        const overIdx = currentFlat.findIndex((f) => f.sortableId === overId);
        if (activeIdx !== -1 && overIdx !== -1) {
          const moved = arrayMove(currentFlat, activeIdx, overIdx);
          optimistic = moved.map((it) => it.sortableId === activeId ? { ...it, profileId: null } : it);
        }
        persist = () => {
          onDetach(ruleId);
          // R-13b fix: the rule's stored sortOrder is member-scale (0..n of
          // its old group) — after detach it joins the top-level interleave,
          // where that small number would snap it to the top. Rewrite the
          // top-level rule order (GLOBAL flat indices, shared with profiles)
          // so the detached rule keeps the position the user dropped it at.
          if (onReorder) {
            const topRuleIds = optimistic
              .filter((f) => f.kind === "rule" && f.profileId == null)
              .map((f) => f.id);
            if (topRuleIds.length > 0) {
              void onReorder(topRuleIds.map((id, i) => ({ id, sortOrder: i })));
            }
          }
        };
      } else {
        // reorder (profile or standalone)
        const fromIdx = currentFlat.findIndex((f) => f.sortableId === activeId);
        const toIdx = currentFlat.findIndex((f) => f.sortableId === overId);
        if (fromIdx !== -1 && toIdx !== -1) {
          const reordered = arrayMove(currentFlat, fromIdx, toIdx);
          optimistic = reordered;
          // Persist reorder for affected containers: derive sortOrder updates
          persist = () => {
            // Split reordered flat into top-level and member groups for sortOrder assignment
            // For simplicity, if active is profile or standalone, treat as top-level reorder
            // Collect top-level ids in order
            const topIdsInOrder: string[] = [];
            const seenProfiles = new Set<string>();
            for (const item of reordered) {
              if (item.kind === "profile") {
                if (!seenProfiles.has(item.id)) {
                  seenProfiles.add(item.id);
                  topIdsInOrder.push(`profile:${item.id}`);
                }
              } else if (item.kind === "rule" && item.profileId == null) {
                topIdsInOrder.push(`rule:${item.id}`);
              }
            }
            // If we are reordering within a single profile's members, handle there
            const activeItem = flatItems.find((f) => f.sortableId === activeId);
            if (activeItem?.kind === "rule" && activeItem.profileId) {
              const profileId = activeItem.profileId;
              const membersInOrder = reordered.filter((f) => f.kind === "rule" && f.profileId === profileId).map((f) => f.id);
              // Need to map to preset reorder within profile: for now call onReorder with those ids
              // The parent's onReorder for presets currently handles all presets; we delegate
              // Use onReorder for member reorder (same callback, but filtered)
              if (onReorder && membersInOrder.length > 0) {
                const updates = membersInOrder.map((id, i) => ({ id, sortOrder: i }));
                void onReorder(updates);
              }
              return;
            }
            // Otherwise top-level reorder: use the GLOBAL flat index as each
            // item's sortOrder (profiles and rules share one positional
            // scale — per-type 0-based indices would collide across tables
            // and the rebuilt interleave would fall back to name tiebreaks,
            // silently losing the dragged order).
            const profileUpdates: Array<{ id: string; sortOrder: number }> = [];
            const presetUpdates: Array<{ id: string; sortOrder: number }> = [];
            reordered.forEach((item, flatIdx) => {
              if (item.kind === "profile") profileUpdates.push({ id: item.id, sortOrder: flatIdx });
              else if (item.kind === "rule" && item.profileId == null) presetUpdates.push({ id: item.id, sortOrder: flatIdx });
            });
            if (profileUpdates.length && onReorderProfiles) void onReorderProfiles(profileUpdates);
            if (presetUpdates.length) void onReorder(presetUpdates);
          };
        }
      }
      return { optimisticItems: optimistic, persist };
    },
  });

  const handleDragStart = (event: Parameters<typeof baseHandleDragStart>[0]) => {
    const id = String(event.active.id);
    if (id.startsWith("profile:")) {
      const pid = id.slice("profile:".length);
      if (expandedIds.has(pid)) {
        handleToggle(pid);
      }
    }
    baseHandleDragStart(event);
  };

  const handleDragEnd = baseHandleDragEnd;

  // Search filter
  const searchLower = search.trim().toLowerCase();
  const filteredFlat = searchLower
    ? flatItems.filter((item) => {
        if (item.kind === "profile") {
          const pr = profiles.find((p) => p.id === item.id);
          return pr?.name.toLowerCase().includes(searchLower);
        }
        const pr = presets.find((p) => p.id === item.id);
        return pr?.name.toLowerCase().includes(searchLower);
      })
    : flatItems;

  const filteredIdsSet = new Set(filteredFlat.map((f) => f.sortableId));

  const startEditing = (preset: RegexPresetRef, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(preset.id);
    setEditName(preset.name);
  };
  const startEditingProfile = (profile: RegexProfileRef, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProfileId(profile.id);
    setEditName(profile.name);
  };

  const saveEdit = () => {
    if (editingId && editName.trim()) onRename(editingId, editName.trim());
    if (editingProfileId && editName.trim() && onRenameProfile) onRenameProfile(editingProfileId, editName.trim());
    setEditingId(null);
    setEditingProfileId(null);
    setEditName("");
  };
  const saveNew = () => {
    if (newName.trim()) onAdd(newName.trim());
    setIsCreating(false);
    setNewName("");
  };
  const saveNewProfile = () => {
    if (newProfileName.trim() && onAddProfile) onAddProfile(newProfileName.trim());
    setIsCreatingProfile(false);
    setNewProfileName("");
  };
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveEdit();
    if (e.key === "Escape") { setEditingId(null); setEditingProfileId(null); setEditName(""); }
  };
  const handleNewKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveNew();
    if (e.key === "Escape") { setIsCreating(false); setNewName(""); }
  };
  const handleNewProfileKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveNewProfile();
    if (e.key === "Escape") { setIsCreatingProfile(false); setNewProfileName(""); }
  };

  const isEmpty = presets.length === 0 && profiles.length === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 py-2.5">
      <div className="shrink-0 px-[13px]">
        <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3 pt-1 pb-[5px]">
          {t("promptManager.regex.tabLabel")}
        </div>
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-s2 px-[9px] py-1.5">
          <Icons.Search />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
            placeholder={t("search_presets")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto">
            {filteredFlat.length === 0 && !isCreating && !isCreatingProfile && !inlineRuleProfileId ? (
              <div className="flex h-full items-center justify-center px-2">
                <EmptyState
                  icon={<Icons.Terminal />}
                  title={isEmpty ? t("promptManager.regex.emptyTitle") : t("no_preset_matches")}
                  sub={isEmpty ? t("promptManager.regex.emptySub") : t("no_preset_matches_sub")}
                />
              </div>
            ) : filteredFlat.map((item) => {
              if (item.kind === "profile") {
                const pr = profiles.find((p) => p.id === item.id);
                if (!pr) return null;
                if (!filteredIdsSet.has(item.sortableId)) return null;
                const isActive = activeProfileId === pr.id;
                const isExpanded = expandedIds.has(pr.id);
                const isEditing = editingProfileId === pr.id;
                if (isEditing) {
                  return (
                    <div key={item.sortableId} className="border-l-2 border-transparent px-3 py-2">
                      <div className="relative flex items-center">
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={handleEditKeyDown}
                          onBlur={saveEdit}
                          className="w-full rounded border border-accent bg-surface px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
                        />
                        <button type="button"
                          onMouseDown={(e) => { e.preventDefault(); saveEdit(); }}
                          className="absolute right-2 text-success transition-colors hover:text-green-400"
                        >
                          <Icons.Check />
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <React.Fragment key={item.sortableId}>
                    <SortableRegexProfileRow
                      p={pr}
                      isActive={isActive}
                      isExpanded={isExpanded}
                      onSelect={(id) => onSelectProfile ? onSelectProfile(id) : onSelect(id)}
                      isMobile={isMobile}
                      startEditing={startEditingProfile}
                      dndDisabled={dndDisabled}
                      onToggle={handleToggle}
                    />
                    {isExpanded && inlineRuleProfileId === pr.id && (
                      <div className="ml-8 border-l border-border/40 px-3 py-2">
                        <div className="relative flex items-center">
                          <input
                            type="text"
                            placeholder={t("promptManager.regex.newNamePlaceholder")}
                            value={inlineRuleName}
                            onChange={(e) => setInlineRuleName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && inlineRuleName.trim() && onAddRuleToProfile) {
                                onAddRuleToProfile(pr.id, inlineRuleName.trim());
                                setInlineRuleName("");
                                setInlineRuleProfileId(null);
                              }
                              if (e.key === "Escape") { setInlineRuleProfileId(null); setInlineRuleName(""); }
                            }}
                            onBlur={() => { if (!inlineRuleName.trim()) { setInlineRuleProfileId(null); setInlineRuleName(""); } else if (onAddRuleToProfile) { onAddRuleToProfile(pr.id, inlineRuleName.trim()); setInlineRuleName(""); setInlineRuleProfileId(null); } }}
                            autoFocus
                            className="w-full rounded border border-border bg-s2 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none focus:border-border2"
                          />
                          <button type="button"
                            onMouseDown={(e) => { e.preventDefault(); if (inlineRuleName.trim() && onAddRuleToProfile) { onAddRuleToProfile(pr.id, inlineRuleName.trim()); setInlineRuleName(""); setInlineRuleProfileId(null); } }}
                            className="absolute right-2 text-success transition-colors hover:text-green-400"
                          >
                            <Icons.Check />
                          </button>
                        </div>
                      </div>
                    )}
                    {isExpanded && (
                      <div className="ml-2">
                        <button type="button"
                          onClick={() => setInlineRuleProfileId(pr.id)}
                          className="flex w-full items-center gap-2 px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t4 hover:text-t2"
                        >
                          <Icons.Plus /> {t("promptManager.regex.memberNewRule")}
                        </button>
                      </div>
                    )}
                  </React.Fragment>
                );
              }
              // rule
              const p = presets.find((pr) => pr.id === item.id);
              if (!p) return null;
              if (!filteredIdsSet.has(item.sortableId)) return null;
              const isActive = activePresetId === p.id;
              const isEditing = editingId === p.id;
              if (isEditing) {
                return (
                  <div key={item.sortableId} className="border-l-2 border-transparent px-3 py-2">
                    <div className="relative flex items-center">
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={saveEdit}
                        className="w-full rounded border border-accent bg-surface px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
                      />
                      <button type="button"
                        onMouseDown={(e) => { e.preventDefault(); saveEdit(); }}
                        className="absolute right-2 text-success transition-colors hover:text-green-400"
                      >
                        <Icons.Check />
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <SortableRegexPresetRow
                  key={item.sortableId}
                  p={p}
                  isActive={isActive}
                  onSelect={onSelect}
                  isMobile={isMobile}
                  startEditing={startEditing}
                  onCopy={onCopy}
                  onExport={onExport}
                  dndDisabled={dndDisabled}
                />
              );
            })}

            {isCreating && (
              <div className="border-l-2 border-transparent px-3 py-2">
                <div className="relative flex items-center">
                  <input
                    ref={newInputRef}
                    type="text"
                    placeholder={t("promptManager.regex.newNamePlaceholder")}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={handleNewKeyDown}
                    onBlur={() => { if (!newName.trim()) setIsCreating(false); else saveNew(); }}
                    className="w-full rounded border border-border bg-s2 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none focus:border-border2"
                  />
                  <button type="button"
                    onMouseDown={(e) => { e.preventDefault(); saveNew(); }}
                    className="absolute right-2 text-success transition-colors hover:text-green-400"
                  >
                    <Icons.Check />
                  </button>
                </div>
              </div>
            )}
            {isCreatingProfile && (
              <div className="border-l-2 border-transparent px-3 py-2">
                <div className="relative flex items-center">
                  <input
                    type="text"
                    placeholder={t("promptManager.regex.newProfilePlaceholder")}
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={handleNewProfileKeyDown}
                    onBlur={() => { if (!newProfileName.trim()) setIsCreatingProfile(false); else saveNewProfile(); }}
                    className="w-full rounded border border-border bg-s2 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none focus:border-border2"
                  />
                  <button type="button"
                    onMouseDown={(e) => { e.preventDefault(); saveNewProfile(); }}
                    className="absolute right-2 text-success transition-colors hover:text-green-400"
                  >
                    <Icons.Check />
                  </button>
                </div>
              </div>
            )}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeDragItem ? (
            <div
              className={cn(
                "flex items-center gap-2 border-l-2 min-h-[56px] px-4",
                activeDragItem.kind === "rule" && presets.find((p) => p.id === activeDragItem.id)?.id === activePresetId
                  ? "border-l-accent bg-accent-dim" : activeDragItem.kind === "profile" && profiles.find((p) => p.id === activeDragItem.id)?.id === activeProfileId
                  ? "border-l-accent bg-accent-dim" : "border-l-transparent bg-s2"
              )}
            >
              <span className="text-base leading-none text-t4">≡</span>
              <span className="truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">
                {activeDragItem.kind === "profile"
                  ? profiles.find((p) => p.id === activeDragItem.id)?.name ?? activeDragItem.id
                  : presets.find((p) => p.id === activeDragItem.id)?.name ?? activeDragItem.id}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="shrink-0 border-t border-border px-3 pt-3">
        <button type="button"
          onClick={() => setIsCreating(true)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
        >
          <Icons.Plus />
          {t("promptManager.regex.newPreset")}
        </button>
        <button type="button"
          onClick={() => setIsCreatingProfile(true)}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
        >
          <Icons.Plus />
          {t("promptManager.regex.newProfile")}
        </button>
        {onImportRegex && (
          <button type="button"
            onClick={onImportRegex}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
          >
            <Icons.Import />
            {t("promptManager.regex.importButton")}
          </button>
        )}
      </div>
    </div>
  );
}

