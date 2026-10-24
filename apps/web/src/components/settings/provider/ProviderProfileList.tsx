import type { ReactNode } from 'react';
import { useT, type TFunc } from '../../../i18n/context.js';
import { useMasterDetail } from '../../shared/MasterDetailModal.js';
import type { ProviderProfileRecord } from '../../../api/types.js';
import { PROVIDER_PRESETS, TYPE_LABELS } from '../../../provider-presets.js';
import { SearchInput } from '../../shared/SearchInput.js';
import { cn } from '../../../lib/cn.js';
import { listHeaderCls } from '../../../lib/field-tokens.js';
import { MasterList } from '../../shared/master-list/master-list.js';
import { SortableMasterListPhoneRow } from '../../shared/master-list/master-list-phone-row.js';
import { MasterListDragOverlayRow } from '../../shared/master-list/master-list-overlay-row.js';
import { arrayMove } from '@dnd-kit/sortable';

// Provider-family master-list source: owns the four families' slots (status
// marker, second line, active marker) + list wiring (search, "+ New",
// reorder payload). Row markup, the drag handle, the drag overlay and the
// phone drill-down row live in `shared/master-list` (forks: 0 there) — this
// list never writes row chrome classes or imports `@dnd-kit/*` beyond the
// reorder math (`arrayMove`).
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
  rowSubLabel?: (profile: TProfile) => ReactNode;
  /** Family-specific connection/status dot class; LLM defaults to its API-key status. */
  statusClassName?: (profile: TProfile, isActive: boolean, isEditing: boolean) => string;
  /** Family-specific title and new-profile translation keys. */
  titleKey?: Parameters<TFunc>[0];
  newProfileKey?: Parameters<TFunc>[0];
  /** Opt-in test-id prefix for adopting family lists; absent for the LLM source instance. */
  testidStem?: string;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  /** When selectionOnly, hides "+ New" but may opt into a family-specific reorder target. */
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
  const dndDisabled = !onReorder || profileSearch.trim().length > 0;

  return (
    <MasterList<TProfile>
      items={profiles}
      getId={(p) => p.id}
      dragDisabled={dndDisabled}
      visibleItems={dndDisabled ? filteredProfiles : undefined}
      onReorderItems={(activeId, overId, currentItems) => {
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
      }}
      header={
        <div className={cn(listHeaderCls, 'mb-1.5 px-4')}>
          {t(titleKey)}
        </div>
      }
      search={
        <SearchInput
          className="mx-3 mb-3"
          placeholder={t('search_profiles')}
          value={profileSearch}
          onChange={(e) => onProfileSearchChange(e.target.value)}
        />
      }
      renderRow={(p) => {
        const isEditing = editingId === p.id;
        const isActive = rowActive?.(p) ?? activeProfileId === p.id;
        return (
          <SortableMasterListPhoneRow
            sortableId={p.id}
            dragDisabled={dndDisabled}
            selected={isEditing}
            active={isActive}
            status={
              <div
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full transition-colors',
                  statusClassName(p, isActive, isEditing),
                )}
              />
            }
            title={p.name}
            secondLine={rowSubLabel(p)}
            onSelect={() => onSelectProfile(p.id)}
            rowTestId={testidStem ? `${testidStem}-profile-row` : undefined}
            dataAttributes={testidStem ? { 'profile-id': p.id } : undefined}
          />
        );
      }}
      renderOverlayRow={(profile) => {
        const isActive = rowActive?.(profile) ?? activeProfileId === profile.id;
        return (
          <MasterListDragOverlayRow
            status={
              <div
                className={cn('h-2 w-2 shrink-0 rounded-full', statusClassName(profile, isActive, editingId === profile.id))}
              />
            }
            active={isActive}
            title={profile.name}
          />
        );
      }}
      footer={
        !selectionOnly ? (
          <div
            data-testid={testidStem ? `${testidStem}-new-profile-btn` : undefined}
            className="mx-3 mt-3 cursor-pointer rounded-md border border-dashed border-border2 py-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
            onClick={() => { void onAddProfile?.(); openDetail(); }}
          >
            {t(newProfileKey)}
          </div>
        ) : undefined
      }
    />
  );
}
