import React, { useState } from 'react';
import { cn } from '../../lib/cn.js';

export interface AvatarAssetState {
  displayUrl?: string;
  initials: string;
  status: 'none' | 'initials' | 'uploaded' | 'broken';
}

export function AvatarDisplay({
  avatar,
  className,
  alt = '',
}: {
  avatar: AvatarAssetState;
  className?: string;
  alt?: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = avatar.displayUrl && !broken && avatar.status !== 'broken';

  const fallbackClass = cn(
    'w-6 h-6 rounded-full bg-s3 flex items-center justify-center text-[calc(var(--ui-fs)-3px)] text-t2 font-ui not-italic shrink-0 overflow-hidden font-semibold tracking-[0.01em]',
    className,
  );

  return (
    <div className={fallbackClass} data-avatar-status={broken ? 'broken' : avatar.status}>
      {showImage ? <img src={avatar.displayUrl} alt={alt} onError={() => setBroken(true)} className="w-full h-full object-cover object-top" /> : avatar.initials}
    </div>
  );
}
