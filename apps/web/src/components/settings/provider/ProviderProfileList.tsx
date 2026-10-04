import React, { type CSSProperties } from 'react';
import { useT, type TFunc } from '../../../i18n/context.js';
import { useMasterDetail } from '../../shared/MasterDetailModal.js';
import type { ProviderProfileRecord } from '../../../api/types.js';
import { PROVIDER_PRESETS, TYPE_LABELS } from '../../../provider-presets.js';
import { SearchInput } from '../../shared/SearchInput.js';
import { cn } from '../../../lib/cn.js';
import { MasterDetailMobileDrillDown } from '../../shared/MasterDetailModal.js';
import { useReorderableList } from '../../../hooks/use-reorderable-list.js';
import { DndContext, DragOverlay, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * forks: 0 — provider-family master-list source.
 *
 * Family-specific row knowledge enters through the slots below; list chrome,
 * search, reorder, selection-only behavior, and mobile drill-down stay here.
 */
export interface ProviderProfileListItem {
  id: string;
  name: string;
  /** LLM fallback metadata; media-family consumers supply row slots instead. */
  providerPreset?: string;
  hasStoredApiKey?: boolean;
}

export interface ProviderProfileListProps<TProfile extends ProviderProfileListItem = ProviderProfileRecord> {
  /** Full (unfiltered) list — the hook's source of truth for reorder. */
  profiles: TProfile[];
  /** Already-filtered subset for rendering (parent controls search). */
  filteredProfiles: TProfile[];
  editingId: string | null;
  /** Canonical active-profile pointer when a family does not need a derived marker. */
  activeProfileId: string | null;
  /** Family-specific effective-active marker (for example ImageGen's fallback pointer). */
  rowActive?: (profile: TProfile) => boolean;
  /** Family-specific secondary row label; LLM defaults to its provider-preset label. */
  rowSubLabel?: (profile: TProfile) => React.ReactNode;
  /** Family-specific connection/status dot class; LLM defaults to its API-key status. */
  statusClassName?: (profile: TProfile, isActive: boolean) => string;
  /** Family-specific title and new-profile translation keys. */
  titleKey?: Parameters<TFunc>[0];
  newProfileKey?: Parameters<TFunc>[0];
  /** Opt-in test-id prefix for adopting family lists; absent for the LLM source instance. */
  testidStem?: string;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  /** When selectionOnly, hides the drag handle, reorder, and "+ New" button. */
  onAddProfile?: () => void;
  onReorder?: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  selectionOnly?: boolean;
}

function defaultRowSubLabel(profile: ProviderProfileListItem): string {
  const presetId = profile.providerPreset ?? '';
  return TYPE_LABELS[presetId] || presetId;
}

function defaultStatusClassName(profile: ProviderProfileListItem, isActive: boolean): string {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === profile.providerPreset);
  const hasRequiredAuth = preset?.noApiKey === true || profile.hasStoredApiKey === true;
  return isActive ? (hasRequiredAuth ? 'bg-success' : 'bg-danger') : 'bg-t4';
}

// A single profile row with a dedicated ≡ drag handle (same pattern as
// SortablePresetRow in PresetList). The row keeps onPointerDown-to-select;
// dragging is only initiated from the handle, avoiding conflicts with the
// drill-down button inside the row.
function SortableProfileRowInner<TProfile extends ProviderProfileListItem>({
  p, isEditing, isActive, onSelectProfile, dndDisabled, rowSubLabel, statusClassName, testidStem,
}: {
  p: TProfile;
  isEditing: boolean;
  isActive: boolean;
  onSelectProfile: (id: string) => void;
  dndDisabled: boolean;
  rowSubLabel: (profile: TProfile) => React.ReactNode;
  statusClassName: (profile: TProfile, isActive: boolean) => string;
  testidStem?: string;
}) {
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
      data-testid={testidStem ? `${testidStem}-profile-row` : undefined}
      data-profile-id={testidStem ? p.id : undefined}
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
          className="mr-1 flex h-8 w-7 shrink-0 select-none items-center justify-center rounded cursor-grab touch-none text-t4 transition-colors hover:bg-s2 hover:text-t1 active:cursor-grabbing sm:h-auto sm:w-5"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <div className="flex w-full items-center gap-3">
        <div
          className={cn(
            'h-2 w-2 shrink-0 rounded-full transition-colors',
            statusClassName(p, isActive),
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
            {rowSubLabel(p)}
          </div>
        </div>
        <MasterDetailMobileDrillDown onSelect={() => onSelectProfile(p.id)} className="py-3" />
      </div>
    </div>
  );
}

const SortableProfileRow = React.memo(SortableProfileRowInner, (prev, next) =>
  prev.isEditing === next.isEditing &&
  prev.isActive === next.isActive &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.dndDisabled === next.dndDisabled,
) as typeof SortableProfileRowInner;

export function ProviderProfileList<TProfile extends ProviderProfileListItem = ProviderProfileRecord>({
  profiles,
  filteredProfiles,
  editingId,
  activeProfileId,
  rowActive,
  rowSubLabel = defaultRowSubLabel,
  statusClassName = defaultStatusClassName,
  titleKey = 'profiles_label',
  newProfileKey = 'new_profile_btn',
  testidStem,
  profileSearch,
  onProfileSearchChange,
  onSelectProfile,
  onAddProfile,
  onReorder,
  selectionOnly = false,
}: ProviderProfileListProps<TProfile>) {
  const { t } = useT();
  const { openDetail } = useMasterDetail();
  const dndDisabled = selectionOnly || profileSearch.trim().length > 0;

  const {
    displayItems,
    sensors,
    activeDragItem: activeDragProfile,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<TProfile>({
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
        const isActive = rowActive?.(profile) ?? activeProfileId === profile.id;
        return (
          <div className="flex items-center gap-2 border-l-[3px] border-l-transparent pl-4 pr-2 min-h-[56px] bg-s2">
            <span className="text-base leading-none text-t4">≡</span>
            <div className={cn('h-2 w-2 shrink-0 rounded-full', statusClassName(profile, isActive))} />
            <span className="truncate text-[13px] font-medium text-t1">{isActive ? '★ ' : ''}{profile.name}</span>
          </div>
        );
      })()
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
      <div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
        {t(titleKey)}
      </div>

      <SearchInput
        className="mx-3 mb-3"
        placeholder={t('search_profiles')}
        value={profileSearch}
        onChange={(e) => onProfileSearchChange(e.target.value)}
      />

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
              const isActive = rowActive?.(p) ?? activeProfileId === p.id;
              return (
                <SortableProfileRow
                  key={p.id}
                  p={p}
                  isEditing={isEditing}
                  isActive={isActive}
                  onSelectProfile={onSelectProfile}
                  dndDisabled={dndDisabled}
                  rowSubLabel={rowSubLabel}
                  statusClassName={statusClassName}
                  testidStem={testidStem}
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
          data-testid={testidStem ? `${testidStem}-new-profile-btn` : undefined}
          className="mx-3 mt-3 cursor-pointer rounded-md border border-dashed border-border2 py-2 text-center font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
          onClick={() => { void onAddProfile?.(); openDetail(); }}
        >
          {t(newProfileKey)}
        </div>
      )}
    </div>
  );
}
