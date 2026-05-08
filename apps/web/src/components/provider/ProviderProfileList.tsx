import React from 'react';
import type { ProviderProfileRecord } from '../../app-client.js';
import { TYPE_LABELS } from '../../provider-presets.js';
import { Icons } from '../shared/icons.js';
import { cn } from '../../lib/cn.js';

interface ProviderProfileListProps {
  filteredProfiles: ProviderProfileRecord[];
  editingId: string | null;
  activeProviderProfileId: string | null;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  onAddProfile: () => void;
}

export function ProviderProfileList({
  filteredProfiles,
  editingId,
  activeProviderProfileId,
  profileSearch,
  onProfileSearchChange,
  onSelectProfile,
  onAddProfile,
}: ProviderProfileListProps) {
  return (
    <div
      className="flex shrink-0 flex-col border-r border-border bg-surface"
      style={{ width: 220, padding: '20px 0 10px' }}
    >
      <div
        className="font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3"
        style={{ padding: '0 16px', marginBottom: 6 }}
      >
        Profiles
      </div>

      <div
        className="flex items-center gap-2 rounded-md border border-border bg-s2"
        style={{ padding: '6px 10px', margin: '0 12px 12px' }}
      >
        <Icons.Search />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4"
          placeholder="Search profiles..."
          value={profileSearch}
          onChange={(e) => onProfileSearchChange(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filteredProfiles.map((p) => (
          <div
            key={p.id}
            className={cn(
              'cursor-pointer overflow-hidden whitespace-nowrap border-l-[3px] text-ellipsis transition-colors hover:bg-s2',
              editingId === p.id
                ? 'border-l-accent bg-accent-dim text-accent-t'
                : 'border-l-transparent text-t2'
            )}
            style={{ padding: '10px 16px' }}
            onClick={() => onSelectProfile(p.id)}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full transition-colors',
                  activeProviderProfileId === p.id
                    ? p.hasStoredApiKey
                      ? 'bg-success'
                      : 'bg-danger'
                    : 'bg-t4'
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="max-w-[150px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">
                  {activeProviderProfileId === p.id ? '★ ' : ''}
                  {p.name}
                </div>
                <div
                  className={cn(
                    'mt-0.5 text-[11px]',
                    editingId === p.id ? 'text-accent-t' : 'text-t4'
                  )}
                >
                  {TYPE_LABELS[p.type] || p.type}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        className="cursor-pointer rounded-md border border-dashed border-border2 text-center font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
        style={{ margin: '12px 12px 0', padding: '8px 0' }}
        onClick={() => void onAddProfile()}
      >
        + New Profile
      </div>
    </div>
  );
}
