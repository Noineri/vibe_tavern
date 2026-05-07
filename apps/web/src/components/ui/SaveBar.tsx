import React from 'react';
import { cn } from '../../lib/cn.js';

interface SaveBarProps {
  dirty: boolean;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onSave: () => void;
  onReset?: () => void;
  label?: string;
  t?: (key: string) => string;
  className?: string;
}

export function SaveBar({ dirty, saveState, onSave, onReset, label, t = (k) => k, className }: SaveBarProps) {
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  return (
    <div className={cn('flex items-center gap-2 text-[calc(var(--ui-fs)-3px)] text-t2 bg-s2 border border-border rounded-md px-3 py-1.5 mb-3', className)}>
      {dirty && <span>{t('unsaved_changes') || 'Unsaved changes'}</span>}
      <button
        className={cn(
          'h-[37px] px-[21px] bg-accent text-on-accent rounded-md text-[calc(var(--ui-fs)-2px)] font-medium font-ui cursor-pointer transition-filter hover:brightness-110',
          isSaved && '!bg-success-dim !text-success-text',
          isSaving && 'opacity-70 !cursor-default',
        )}
        disabled={(!dirty && !isSaved) || isSaving}
        onClick={onSave}
      >
        {isSaving ? t('saving') : isSaved ? t('saved') : label || t('save_btn')}
      </button>
      {onReset && dirty && (
        <button className="h-[37px] px-4 bg-transparent text-t3 rounded-md text-[calc(var(--ui-fs)-2px)] font-ui cursor-pointer transition-colors hover:text-t1" onClick={onReset}>{t('cancel_btn')}</button>
      )}
    </div>
  );
}

interface SaveButtonProps {
  dirty: boolean;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onClick: () => void;
  label?: string;
  t?: (key: string) => string;
}

export function SaveButton({ dirty, saveState, onClick, label, t = (k) => k }: SaveButtonProps) {
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  return (
    <button
      className={cn(
        'h-[37px] px-[21px] bg-accent text-on-accent rounded-md text-[calc(var(--ui-fs)-2px)] font-medium font-ui cursor-pointer transition-filter hover:brightness-110',
        isSaved && '!bg-success-dim !text-success-text',
        isSaving && 'opacity-70 !cursor-default',
      )}
      disabled={(!dirty && !isSaved) || isSaving}
      onClick={onClick}
    >
      {isSaving ? t('saving') : isSaved ? <>{t('saved')}</> : label || t('save_btn')}
    </button>
  );
}
