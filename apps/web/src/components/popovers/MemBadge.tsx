import React from 'react';
import { CustomTooltip } from '../shared/Tooltip.js';

interface MemBadgeProps {
  label: string;
  onClick: () => void;
}

export function MemBadge({ label, onClick }: MemBadgeProps) {
  return (
    <CustomTooltip content={label}>
    <div className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-s2 px-3 py-1 text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors duration-150 hover:border-accent hover:text-accent-t"
      onClick={onClick}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"/>
      <span>{label}</span>
    </div>
    </CustomTooltip>
  );
}
