import React from 'react';
import { cn } from '../../lib/cn.js';

interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ items, activeId, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex border-b border-border gap-4 mb-4', className)}>
      {items.map(item => (
        <div
          key={item.id}
          className={cn(
            'text-xs font-medium px-1 py-2 cursor-pointer border-b-2 transition-colors duration-150 hover:text-t1',
            item.id === activeId ? 'text-accent-t border-accent' : 'text-t3 border-transparent',
          )}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
