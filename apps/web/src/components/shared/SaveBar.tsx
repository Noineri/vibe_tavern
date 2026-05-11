import React from 'react';
import { cn } from '../../lib/cn.js';
import { useT } from '../../i18n/context.js';

interface SaveBarProps {
  dirty: boolean;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onSave: () => void;
  onReset?: () => void;
  label?: string;
  className?: string;
}

export function SaveBar({ dirty, saveState, onSave, onReset, label, className }: SaveBarProps) {
  const { t } = useT();
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  return (
    <div className={cn('flex items-center gap-2 text-[calc(var(--ui-fs)-3px)] text-t2 bg-s2 border border-border rounded-md mb-3', className)} style={{padding:'6px 12px'}}>
      {dirty && <span>{t('unsaved_changes')}</span>}
      <button
        className={cn(
          'h-[37px] bg-accent text-on-accent rounded-md text-[calc(var(--ui-fs)-2px)] font-medium font-ui cursor-pointer transition-filter hover:brightness-110',
          isSaved && '!bg-success-dim !text-success-text',
          isSaving && 'opacity-70 !cursor-default',
        )}
        style={{paddingLeft:21, paddingRight:21}}
        disabled={(!dirty && !isSaved) || isSaving}
        onClick={onSave}
      >
        {isSaving ? t('saving') : isSaved ? t('saved') : label || t('save_btn')}
      </button>
      {onReset && dirty && (
        <button className="h-[37px] bg-transparent text-t3 rounded-md text-[calc(var(--ui-fs)-2px)] font-ui cursor-pointer transition-colors hover:text-t1" style={{paddingLeft:16, paddingRight:16}} onClick={onReset}>{t('cancel_btn')}</button>
      )}
    </div>
  );
}

interface SaveButtonProps {
  dirty: boolean;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onClick: () => void;
  label?: string;
}

export function SaveButton({ dirty, saveState, onClick, label }: SaveButtonProps) {
  const { t } = useT();
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  return (
    <button
      className={cn(
        'h-[37px] bg-accent text-on-accent rounded-md text-[calc(var(--ui-fs)-2px)] font-medium font-ui cursor-pointer transition-filter hover:brightness-110',
        isSaved && '!bg-success-dim !text-success-text',
        isSaving && 'opacity-70 !cursor-default',
      )}
      style={{paddingLeft:21, paddingRight:21}}
      disabled={(!dirty && !isSaved) || isSaving}
      onClick={onClick}
    >
      {isSaving ? t('saving') : isSaved ? <>{t('saved')}</> : label || t('save_btn')}
    </button>
  );
}
