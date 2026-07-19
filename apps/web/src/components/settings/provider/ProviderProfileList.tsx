import React, { type CSSProperties } from 'react';
import { useT } from '../../../i18n/context.js';
import { useIsMobile } from '../../../hooks/use-mobile.js';
import { useMasterDetail } from '../../shared/MasterDetailModal.js';
import type { ProviderProfileRecord } from '../../../app-client.js';
import { PROVIDER_PRESETS, TYPE_LABELS } from '../../../provider-presets.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { MasterDetailMobileDrillDown } from '../../shared/MasterDetailModal.js';
import { useReorderableList } from '../../../hooks/use-reorderable-list.js';
import { DndContext, DragOverlay, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ProviderProfileListProps {
  /** Full (unfiltered) list — the hook's source of truth for reorder. */
  profiles: ProviderProfileRecord[];
  /** Already-filtered subset for rendering (parent controls search). */
  filteredProfiles: ProviderProfileRecord[];
  editingId: string | null;
  activeProviderProfileId: string | null;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  /** When selectionOnly, hides the drag handle, reorder, and "+ New" button. */
  onAddProfile?: () => void;
  onReorder?: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  selectionOnly?: boolean;
}

// A single profile row with a dedicated ≡ drag handle (same pattern as
// SortablePresetRow in PresetList). The row keeps onPointerDown-to-select;
// dragging is only initiated from the handle, avoiding conflicts with the
// drill-down button inside the row.
const SortableProfileRow = React.memo(({
  p, isEditing, isActive, isMobile, onSelectProfile, dndDisabled,
}: {
  p: ProviderProfileRecord;
  isEditing: boolean;
  isActive: boolean;
  isMobile: boolean;
  onSelectProfile: (id: string) => void;
  dndDisabled: boolean;
}) => {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === p.providerPreset);
  const hasRequiredAuth = preset?.noApiKey === true || p.hasStoredApiKey;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: p.id,
    disabled: dndDisabled,
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
      className={cn(
        'cursor-pointer border-l-[3px] pl-4 pr-2 min-h-[56px] flex items-center active:bg-s2 sm:overflow-hidden sm:whitespace-nowrap sm:text-ellipsis sm:transition-colors touch-manipulation',
        isEditing
          ? 'border-l-accent bg-accent-dim text-accent-t'
          : 'border-l-transparent text-t2 hover:bg-s2',
      )}
      onPointerDown={() => onSelectProfile(p.id)}
    >
      {!dndDisabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="mr-1 shrink-0 cursor-grab touch-none text-t4 transition-colors hover:text-t1 active:cursor-grabbing"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <div className="flex w-full items-center gap-3">
        <div
          className={cn(
            'h-2 w-2 shrink-0 rounded-full transition-colors',
            isActive
              ? hasRequiredAuth
                ? 'bg-success'
                : 'bg-danger'
              : 'bg-t4',
          )}
        />
        <div className="min-w-0 flex-1 py-2">
          <div className="truncate text-[13px] font-medium">
            {isActive ? '★ ' : ''}
            {p.name}
          </div>
          <div
            className={cn(
              'mt-0.5 text-[11px]',
              isEditing ? 'text-accent-t' : 'text-t4',
            )}
          >
            {TYPE_LABELS[p.providerPreset] || p.providerPreset}
          </div>
        </div>
        <MasterDetailMobileDrillDown onSelect={() => onSelectProfile(p.id)} className="py-3" />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isEditing === next.isEditing &&
  prev.isActive === next.isActive &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.dndDisabled === next.dndDisabled);

export function ProviderProfileList({
  profiles,
  filteredProfiles,
  editingId,
  activeProviderProfileId,
  profileSearch,
  onProfileSearchChange,
  onSelectProfile,
  onAddProfile,
  onReorder,
  selectionOnly = false,
}: ProviderProfileListProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { openDetail } = useMasterDetail();
  const dndDisabled = selectionOnly || profileSearch.trim().length > 0;

  const {
    displayItems,
    sensors,
    activeDragItem: activeDragProfile,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<ProviderProfileRecord>({
    items: profiles,
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
        persist: () => onReorder?.(reordered.map((p, i) => ({ id: p.id, sortOrder: i }))),
      };
    },
  });

  // When not searching, render the hook's displayItems (reflects optimistic
  // reorder). When searching, the parent's filteredProfiles is already the
  // correct subset, and DnD is disabled so no optimistic in flight.
  const rendered = dndDisabled ? filteredProfiles : displayItems;

  const dragOverlayProfile = activeDragProfile
    ? (() => {
        const profile = activeDragProfile;
        const preset = PROVIDER_PRESETS.find((c) => c.id === profile.providerPreset);
        const isActive = activeProviderProfileId === profile.id;
        const hasRequiredAuth = preset?.noApiKey === true || profile.hasStoredApiKey;
        return (
          <div className="flex items-center gap-2 border-l-[3px] border-l-transparent pl-4 pr-2 min-h-[56px] bg-s2">
            <span className="text-base leading-none text-t4">≡</span>
            <div className={cn('h-2 w-2 shrink-0 rounded-full', isActive ? (hasRequiredAuth ? 'bg-success' : 'bg-danger') : 'bg-t4')} />
            <span className="truncate text-[13px] font-medium text-t1">{isActive ? '★ ' : ''}{profile.name}</span>
          </div>
        );
      })()
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
      <div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
        {t('profiles_label')}
      </div>

      <div className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-border bg-s2 px-2.5 py-1.5">
        <Icons.Search />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4"
          placeholder={t('search_profiles')}
          value={profileSearch}
          onChange={(e) => onProfileSearchChange(e.target.value)}
        />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={rendered.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto">
            {rendered.map((p) => {
              const isEditing = editingId === p.id;
              const isActive = activeProviderProfileId === p.id;
              return (
                <SortableProfileRow
                  key={p.id}
                  p={p}
                  isEditing={isEditing}
                  isActive={isActive}
                  isMobile={isMobile}
                  onSelectProfile={onSelectProfile}
                  dndDisabled={dndDisabled}
                />
              );
            })}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {dragOverlayProfile}
        </DragOverlay>
      </DndContext>

      {!selectionOnly && (
        <div
          className="mx-3 mt-3 cursor-pointer rounded-md border border-dashed border-border2 py-2 text-center font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
          onClick={() => { void onAddProfile?.(); openDetail(); }}
        >
          {t('new_profile_btn')}
        </div>
      )}
    </div>
  );
}
