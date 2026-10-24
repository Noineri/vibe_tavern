import React, { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { listHeaderCls } from "../../../lib/field-tokens.js";
import { Icons } from "../../shared/icons.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { MasterDetailMobileDrillDown } from "../../shared/MasterDetailModal.js";
import { MasterList } from "../../shared/master-list/master-list.js";
import { MasterListRow } from "../../shared/master-list/master-list-row.js";
import { SortableMasterListPhoneRow } from "../../shared/master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../../shared/master-list/master-list-overlay-row.js";
import { MasterListDropSlot } from "../../shared/master-list/master-list-drop-slot.js";
import { arrayMove } from "@dnd-kit/sortable";
import { buildFlatVisualOrder, interpretRegexDrop, type FlatItem } from "../../../lib/regex-profile-drop.js";
import {
  regexProfileAvailability,
  regexRuleAvailability,
  type RegexProfileAvailability,
  type RegexRuleAvailability,
} from "../../../lib/regex-availability.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";
import { RegexAvailabilityBadge } from "./RegexAvailabilityBadge.js";
import {
  isMemberRuleDrag,
  memberRuleIdForStandaloneDrop,
  regexStandaloneDropId,
} from "./regex-profile-drop.js";

type RegexAvailability = RegexProfileAvailability | RegexRuleAvailability;

interface RegexPresetListProps {
  presets: RegexPresetRecord[];
  profiles?: RegexProfileRecord[];
  regexLinkCounts?: Record<string, number | undefined>;
  regexProfileLinkCounts?: Record<string, number | undefined>;
  activePresetId: string | null;
  activeProfileId?: string | null;
  expandedProfileIds?: string[];
  onSelect: (id: string) => void;
  onSelectProfile?: (id: string) => void;
  onAdd: (name: string) => void;
  onAddProfile?: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  onRenameProfile?: (id: string, newName: string) => void;
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onReorderProfiles?: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onAttach?: (profileId: string, ruleId: string) => void | Promise<unknown>;
  onDetach?: (ruleId: string) => void | Promise<unknown>;
  onToggleProfile?: (id: string) => void;
  onImportRegex?: () => void;
}

// Row anatomy lives in `shared/master-list` (handle, status slot, wrapping
// title, rename slot, overlay, phone drill-down row). This list supplies data
// + slots: the profile accordion toggle (the title slot carries the caret +
// name + count button — clicking it expands AND selects, exactly like the old
// row), rule/profile rename editors through the `rename` slot, availability
// badges + edit buttons in trailing, and the standalone-drop flow slot (the
// primitive's `renderDragSlot` + `MasterListDropSlot`, which owns the
// droppable registration). Reorder/attach/detach math is unchanged — it runs
// in `onReorderItems` over the full flat order; only presentation + the drag
// shell moved.
export function RegexPresetList({ presets, profiles = [], regexLinkCounts = {}, regexProfileLinkCounts = {}, activePresetId, activeProfileId, expandedProfileIds: controlledExpanded, onSelect, onSelectProfile, onAdd, onAddProfile, onRename, onRenameProfile, onReorder, onReorderProfiles, onAttach, onDetach, onToggleProfile, onImportRegex }: RegexPresetListProps) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set());
  const manualExpandedIds = useMemo(() => {
    if (controlledExpanded) return new Set(controlledExpanded);
    return internalExpanded;
  }, [controlledExpanded, internalExpanded]);
  const manualExpansionSnapshot = useRef<Set<string>>(new Set());
  const [isStandaloneDropOver, setIsStandaloneDropOver] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingId || editingProfileId) editInputRef.current?.focus(); }, [editingId, editingProfileId]);
  useEffect(() => { if (isCreating || isCreatingProfile) newInputRef.current?.focus(); }, [isCreating, isCreatingProfile]);

  const searchLower = search.trim().toLowerCase();
  const isFiltering = searchLower.length > 0;
  const dndDisabled = isFiltering;

  const flatItems: FlatItem[] = useMemo(() => buildFlatVisualOrder(
    profiles.map((profile) => ({ id: profile.id, sortOrder: profile.sortOrder, name: profile.name })),
    presets.map((preset) => ({ id: preset.id, sortOrder: preset.sortOrder, name: preset.name, profileId: preset.profileId })),
    manualExpandedIds,
  ), [profiles, presets, manualExpandedIds]);

  // Sortable registration covers the full flat order minus the rows under
  // inline rename (their rendered form is a plain input, not a sortable).
  const editingSortable = editingId ? `rule:${editingId}` : editingProfileId ? `profile:${editingProfileId}` : null;
  const sortableIds = useMemo(() => (
    flatItems.filter((f) => f.sortableId !== editingSortable).map((f) => f.sortableId)
  ), [flatItems, editingSortable]);

  const handleToggle = (id: string) => {
    if (isFiltering) return;
    if (onToggleProfile) onToggleProfile(id);
    else setInternalExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredFlat = useMemo(() => {
    if (!isFiltering) return flatItems;
    const matchedProfileIds = new Set<string>();
    const visibleRuleIds = new Set<string>();
    for (const profile of profiles) {
      const profileMatches = profile.name.toLowerCase().includes(searchLower);
      const members = presets.filter((preset) => preset.profileId === profile.id);
      const matchingMembers = members.filter((preset) => preset.name.toLowerCase().includes(searchLower));
      if (profileMatches || matchingMembers.length > 0) matchedProfileIds.add(profile.id);
      for (const member of profileMatches ? members : matchingMembers) visibleRuleIds.add(member.id);
    }
    for (const preset of presets) {
      if (preset.profileId === null && preset.name.toLowerCase().includes(searchLower)) visibleRuleIds.add(preset.id);
    }
    return buildFlatVisualOrder(
      profiles.filter((profile) => matchedProfileIds.has(profile.id)).map((profile) => ({ id: profile.id, sortOrder: profile.sortOrder, name: profile.name })),
      presets.filter((preset) => visibleRuleIds.has(preset.id)).map((preset) => ({ id: preset.id, sortOrder: preset.sortOrder, name: preset.name, profileId: preset.profileId })),
      matchedProfileIds,
    );
  }, [flatItems, isFiltering, presets, profiles, searchLower]);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);

  const startEditing = (preset: RegexPresetRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(preset.id);
    setEditName(preset.name);
  };
  const startEditingProfile = (profile: RegexProfileRecord, e: React.MouseEvent) => {
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

  const renderRenameEditor = (
    value: string,
    onChange: (value: string) => void,
    onKeyDown: (e: React.KeyboardEvent) => void,
    onCommit: () => void,
    placeholder?: string,
  ) => (
    <div className="relative flex items-center">
      <InlineRenameInput
        ref={editInputRef}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCommit}
      />
      <button type="button"
        onMouseDown={(e) => { e.preventDefault(); onCommit(); }}
        className="absolute right-2 text-success transition-colors hover:text-green-400"
      >
        <Icons.Check />
      </button>
    </div>
  );

  const isEmpty = presets.length === 0 && profiles.length === 0;

  // ── Accordion rendering (owner ruling 2026-10-09: «как аккордеонов у
  // нас») ── the profile member section animates with the repo's canonical
  // grid-rows collapse (the InputArea / PerSendPrefillStrip idiom). The
  // RENDER order always carries members under their profile; the 0fr/1fr
  // wrapper owns visibility, so expanding animates height+opacity instead
  // of mounting rows. `sortableIds` still derive from `flatItems` (real
  // expansion) — a collapsed member is never a sortable/drop target.
  const renderRuleRow = (p: RegexPresetRecord, sortableId: string) => {
    const isActive = activePresetId === p.id;
    if (editingId === p.id) {
      return (
        <MasterListRow
          rename={renderRenameEditor(editName, setEditName, handleEditKeyDown, saveEdit)}
        />
      );
    }
    const availability = regexRuleAvailability({
      rule: p,
      ruleLinkCount: regexLinkCounts[p.id],
      profile: p.profileId === null ? null : profileById.get(p.profileId) ?? null,
      profileLinkCount: p.profileId === null ? undefined : regexProfileLinkCounts[p.profileId],
    });
    const shadowed = p.profileId !== null && (p.isGlobal || (regexLinkCounts[p.id] ?? 0) > 0);
    const row = (
      <SortableMasterListPhoneRow
        sortableId={sortableId}
        dragDisabled={dndDisabled}
        selected={isActive}
        status={shadowed ? (
          <CustomTooltip content={t("promptManager.regex.memberShadowed")}>
            <span role="img" aria-label={t("promptManager.regex.memberShadowed")} className="flex shrink-0 p-1">
              <span className="h-[6px] w-[6px] rounded-full bg-danger" />
            </span>
          </CustomTooltip>
        ) : undefined}
        title={p.name}
        onSelect={() => onSelect(p.id)}
        trailing={
          <>
            <button type="button"
              onClick={(e) => startEditing(p, e)}
              className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
            ><Icons.Edit /></button>
            <div className="ml-auto flex items-center gap-1">
              <RegexAvailabilityBadge availability={availability} />
              <button type="button"
                onClick={(e) => startEditing(p, e)}
                className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
              ><Icons.Edit /></button>
              <MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-1" />
            </div>
          </>
        }
      />
    );
    // Member rows keep their nested indent (the tree line under the profile)
    // — the accordion owns collapse, this wrapper owns the indent.
    return p.profileId != null ? <div className="ml-4 border-l border-border/50">{row}</div> : row;
  };

  const renderProfileRow = (pr: RegexProfileRecord, sortableId: string, memberCount: number) => {
    const isActive = activeProfileId === pr.id;
    const isExpanded = isFiltering || manualExpandedIds.has(pr.id);
    if (editingProfileId === pr.id) {
      return (
        <MasterListRow
          rename={renderRenameEditor(editName, setEditName, handleEditKeyDown, saveEdit)}
        />
      );
    }
    return (
      <SortableMasterListPhoneRow
        sortableId={sortableId}
        dragDisabled={dndDisabled}
        selected={isActive}
        title={
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleToggle(pr.id); }}
            aria-label={isExpanded ? t("promptManager.regex.collapseProfile") : t("promptManager.regex.expandProfile")}
            aria-expanded={isExpanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className={cn("shrink-0 text-t3 transition-transform duration-200 ease-out", isExpanded && "rotate-90")}><Icons.Caret direction="r" /></span>
            <span className={cn("min-w-0 break-words", isActive ? "text-accent-t" : "text-t1", pr.disabled && "opacity-50")}>{pr.name}</span>
            <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t4">({memberCount})</span>
          </button>
        }
        onSelect={() => onSelectProfile ? onSelectProfile(pr.id) : onSelect(pr.id)}
        trailing={
          <>
            <button type="button"
              onClick={(e) => startEditingProfile(pr, e)}
              className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
            ><Icons.Edit /></button>
            <div className="ml-auto flex items-center gap-1">
              <RegexAvailabilityBadge availability={regexProfileAvailability(pr, presets, regexProfileLinkCounts[pr.id])} />
              <button type="button"
                onClick={(e) => startEditingProfile(pr, e)}
                className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
              ><Icons.Edit /></button>
              <MasterDetailMobileDrillDown onSelect={() => onSelectProfile ? onSelectProfile(pr.id) : onSelect(pr.id)} className="py-1" />
            </div>
          </>
        }
      />
    );
  };

  const renderGroups = useMemo(() => {
    const base = isFiltering ? filteredFlat : buildFlatVisualOrder(
      profiles.map((profile) => ({ id: profile.id, sortOrder: profile.sortOrder, name: profile.name })),
      presets.map((preset) => ({ id: preset.id, sortOrder: preset.sortOrder, name: preset.name, profileId: preset.profileId })),
      new Set(profiles.map((profile) => profile.id)),
    );
    const groups: Array<{ lead: FlatItem; members: FlatItem[] }> = [];
    for (const item of base) {
      const last = groups[groups.length - 1];
      if (item.kind === "profile" || item.profileId === null || !last || last.lead.kind !== "profile") {
        groups.push({ lead: item, members: [] });
      } else {
        last.members.push(item);
      }
    }
    return groups;
  }, [isFiltering, filteredFlat, profiles, presets]);

  // The primitive renders top-level leads; profile members render nested in
  // their profile's accordion (same grouping as before — the committed data
  // owns the render, exactly like the old row map).
  const visibleLeads = useMemo(() => renderGroups.map((group) => group.lead), [renderGroups]);
  const membersByLead = useMemo(() => {
    const map = new Map<string, FlatItem[]>();
    for (const group of renderGroups) map.set(group.lead.sortableId, group.members);
    return map;
  }, [renderGroups]);
  const presetById = useMemo(() => new Map<string, RegexPresetRecord>(presets.map((preset) => [preset.id, preset])), [presets]);

  const renderLeadRow = (item: FlatItem) => {
    if (item.kind === "profile") {
      const pr = profiles.find((p) => p.id === item.id);
      if (!pr) return null;
      const memberItems = membersByLead.get(item.sortableId) ?? [];
      const memberCount = presets.filter((preset) => preset.profileId === pr.id).length;
      const open = isFiltering || manualExpandedIds.has(pr.id);
      return (
        <React.Fragment>
          {renderProfileRow(pr, item.sortableId, memberCount)}
          {/* Owner rulings 2026-10-09: no duplicate quick-create row
              inside the list (the Profile pane owns rule creation), and
              member sections collapse with the canonical grid-rows idiom. */}
          {memberItems.length > 0 ? (
            <div
              data-testid={`regex-members-${pr.id}`}
              className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
              style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
              aria-hidden={!open}
            >
              <div className="overflow-hidden">
                {memberItems.map((member) => {
                  const p = presetById.get(member.id);
                  return p ? <React.Fragment key={member.sortableId}>{renderRuleRow(p, member.sortableId)}</React.Fragment> : null;
                })}
              </div>
            </div>
          ) : null}
        </React.Fragment>
      );
    }
    const p = presetById.get(item.id);
    if (!p) return null;
    return renderRuleRow(p, item.sortableId);
  };

  return (
    <MasterList<FlatItem>
      items={flatItems}
      getId={(f) => f.sortableId}
      dragDisabled={dndDisabled}
      sortableIds={sortableIds}
      visibleItems={visibleLeads}
      onDragStartExtra={(event) => {
        setIsStandaloneDropOver(false);
        const id = String(event.active.id);
        if (id.startsWith("profile:")) {
          const pid = id.slice("profile:".length);
          if (manualExpandedIds.has(pid)) {
            handleToggle(pid);
          }
        }
      }}
      onDragOver={(event) => {
        setIsStandaloneDropOver(
          memberRuleIdForStandaloneDrop(
            flatItems.find((f) => f.sortableId === String(event.active.id)) ?? null,
            event.over ? String(event.over.id) : null,
          ) !== null,
        );
      }}
      onDragCancelExtra={() => {
        setIsStandaloneDropOver(false);
      }}
      onReorderItems={(activeId, overId, currentFlat) => {
        // Dropping a member rule onto the standalone target detaches it —
        // handled before the flat-order interpretation (which knows nothing
        // of the standalone slot id).
        const standaloneRuleId = memberRuleIdForStandaloneDrop(
          currentFlat.find((f) => f.sortableId === activeId) ?? null,
          overId,
        );
        if (standaloneRuleId) {
          return { optimisticItems: currentFlat, persist: () => { onDetach?.(standaloneRuleId); } };
        }
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
      }}
      renderDragSlot={(activeItem) => (
        isMemberRuleDrag(activeItem) ? (
          /* Owner ruling 2026-10-09: the Standalone drop row is a SLOT in the
             scrolling flow — rendered INSIDE the scroll container as its first
             row, right above the rules — never a fixed band above the scroll
             area (the band displaced/covered the profile row in ~90% of drag
             positions). As a flow slot it pushes rows down naturally and
             scrolls with the list. */
          <MasterListDropSlot droppableId={regexStandaloneDropId} testId="regex-standalone-drop">
            {(isOver) => (
              <div
                className={cn(
                  "flex min-h-11 w-full items-center justify-center gap-2 border border-dashed border-border2 bg-s1 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors",
                  (isOver || isStandaloneDropOver) && "border-accent bg-accent-dim text-accent",
                )}
              >
                <Icons.Expand />
                <span>{t("promptManager.regex.moveToStandalone")}</span>
              </div>
            )}
          </MasterListDropSlot>
        ) : null
      )}
      header={
        <div className="shrink-0 px-[13px]">
          <div className={cn(listHeaderCls, "pt-1 pb-[5px]")}>
            {t("promptManager.regex.tabLabel")}
          </div>
        </div>
      }
      search={
        <div className="shrink-0 px-[13px]">
          <SearchInput
            className="mb-2"
            placeholder={t("promptManager.regex.searchPlaceholder")}
            value={search}
            onChange={(e) => {
              if (!isFiltering && e.target.value.trim()) manualExpansionSnapshot.current = new Set(manualExpandedIds);
              setSearch(e.target.value);
            }}
          />
        </div>
      }
      emptyState={
        visibleLeads.length === 0 && !isCreating && !isCreatingProfile ? (
          <div className="flex h-full items-center justify-center px-2">
            <EmptyState
              icon={<Icons.Terminal />}
              title={isEmpty ? t("promptManager.regex.emptyTitle") : t("no_preset_matches")}
              sub={isEmpty ? t("promptManager.regex.emptySub") : t("no_preset_matches_sub")}
            />
          </div>
        ) : undefined
      }
      renderRow={renderLeadRow}
      renderOverlayRow={(item) => (
        <MasterListDragOverlayRow
          active={item.kind === "rule"
            ? presets.find((p) => p.id === item.id)?.id === activePresetId
            : profiles.find((p) => p.id === item.id)?.id === activeProfileId}
          title={item.kind === "profile"
            ? profiles.find((p) => p.id === item.id)?.name ?? item.id
            : presets.find((p) => p.id === item.id)?.name ?? item.id}
        />
      )}
      footer={
        <div className="shrink-0 border-t border-border px-3 pt-3">
          {isCreating ? (
            <div className="relative flex items-center">
              <InlineRenameInput
                ref={newInputRef}
                placeholder={t("promptManager.regex.newNamePlaceholder")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={handleNewKeyDown}
                onBlur={() => { if (!newName.trim()) setIsCreating(false); else saveNew(); }}
              />
              <button type="button"
                onMouseDown={(e) => { e.preventDefault(); saveNew(); }}
                className="absolute right-2 text-success transition-colors hover:text-green-400"
              >
                <Icons.Check />
              </button>
            </div>
          ) : (
            <button type="button"
              onClick={() => setIsCreating(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
            >
              <Icons.Plus />
              {t("promptManager.regex.newPreset")}
            </button>
          )}
          {isCreatingProfile ? (
            <div className="relative mt-2 flex items-center">
              <InlineRenameInput
                placeholder={t("promptManager.regex.newProfilePlaceholder")}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={handleNewProfileKeyDown}
                onBlur={() => { if (!newProfileName.trim()) setIsCreatingProfile(false); else saveNewProfile(); }}
              />
              <button type="button"
                onMouseDown={(e) => { e.preventDefault(); saveNewProfile(); }}
                className="absolute right-2 text-success transition-colors hover:text-green-400"
              >
                <Icons.Check />
              </button>
            </div>
          ) : (
            <button type="button"
              onClick={() => setIsCreatingProfile(true)}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
            >
              <Icons.Plus />
              {t("promptManager.regex.newProfile")}
            </button>
          )}
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
      }
    />
  );
}
