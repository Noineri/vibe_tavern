import React from 'react';
import { AvatarDisplay } from './AvatarDisplay.js';
import type { AvatarAssetState } from './AvatarDisplay.js';

const CameraIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>
);

export function AvatarPicker({
  avatar,
  inputId,
  t = (key) => key,
  onPick,
  onRemove,
}: {
  avatar: AvatarAssetState;
  inputId: string;
  t?: (key: string) => string;
  onPick(file: File): void;
  onRemove?: () => void;
}) {
  const showCamera = avatar.status === 'initials' || avatar.status === 'none';

  return (
    <div
      className="group relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent hover:text-accent-t"
      data-avatar-picker-status={avatar.status}
      onClick={() => document.getElementById(inputId)?.click()}
      title={t('upload_avatar')}
    >
      <input
        type="file"
        id={inputId}
        accept="image/*"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
      />
      {showCamera ? (
        <div className="flex h-full w-full items-center justify-center text-t3 transition-colors group-hover:text-accent-t">
          <CameraIcon />
        </div>
      ) : (
        <AvatarDisplay avatar={avatar} className="h-full w-full rounded-full overflow-hidden [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top" />
      )}
      {onRemove && avatar.status === 'uploaded' && (
        <button
          type="button"
          className="absolute right-0.5 bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-t4 opacity-0 transition-all hover:text-danger group-hover:opacity-100"
          onClick={e => { e.stopPropagation(); onRemove(); }}
          title={t('remove')}
        >
          <svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
      )}
    </div>
  );
}
