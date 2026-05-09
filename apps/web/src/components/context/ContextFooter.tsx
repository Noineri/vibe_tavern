export function ContextFooter({
  topTab,
  onClose,
  disabled,
  t = (k) => k,
  contextWindow,
  onSaveSummary,
  isSaving = false,
}: {
  topTab: string;
  onClose: () => void;
  disabled: boolean;
  t?: (key: string) => string;
  contextWindow: { used: number; limit: number };
  onSaveSummary?: () => void;
  isSaving?: boolean;
}) {
  const pct = contextWindow.limit > 0 ? Math.min(100, Math.round((contextWindow.used / contextWindow.limit) * 100)) : 0;

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-border" style={{padding:'14px 20px'}}>
      {topTab === 'memory' ? (
        <>
          <div className="flex-1">
            <div className="font-ui text-xs text-t3">{t('memory_context_window_label')}</div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-s3">
                <div className="h-full bg-accent" style={{width: `${pct}%`}} />
              </div>
              <div className="font-ui text-xs text-t3">{contextWindow.used} / {contextWindow.limit}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="h-[37px] cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" style={{padding:'0 16px'}} onClick={onClose}>
              {t('cancel_btn')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex-1" />
          <div className="flex gap-2">
            <button
              className="h-[37px] cursor-pointer rounded-md bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-40"
              style={{padding:'0 18px'}}
              disabled={disabled || isSaving}
              onClick={onSaveSummary}
            >
              {isSaving ? t('saving_btn') : t('save_summary_btn')}
            </button>
            <button className="h-[37px] cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" style={{padding:'0 16px'}} onClick={onClose}>
              {t('cancel_btn')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
