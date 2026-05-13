import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";

export function ContextFooter({
  topTab,
  onClose,
  disabled,
  contextWindow,
  onSaveSummary,
  isSaving = false,
  autoSaveFlash = false,
}: {
  topTab: string;
  onClose: () => void;
  disabled: boolean;
  contextWindow: { used: number; limit: number };
  onSaveSummary?: () => void;
  isSaving?: boolean;
  autoSaveFlash?: boolean;
}) {
  const { t } = useT();
  const pct = contextWindow.limit > 0 ? Math.min(100, Math.round((contextWindow.used / contextWindow.limit) * 100)) : 0;

  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-[14px]">
      <div className="flex items-center gap-2 font-ui text-[12px] text-t3 transition-opacity duration-300" style={{ opacity: autoSaveFlash ? 1 : 0 }}>
        <Icons.Floppy /> {t("autosaving")}
      </div>
      {topTab === 'memory' ? (
        <div className="flex-1 flex items-center justify-end gap-2">
          <div className="font-ui text-xs text-t3">{t('memory_context_window_label')}</div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-[80px] overflow-hidden rounded-full bg-s3">
              <div className="h-full bg-accent" style={{width: `${pct}%`}} />
            </div>
            <div className="font-ui text-xs text-t3">{contextWindow.used} / {contextWindow.limit}</div>
          </div>
          <button className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            className="h-[37px] cursor-pointer rounded-md bg-accent px-[18px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            disabled={disabled || isSaving}
            onClick={onSaveSummary}
          >
            {isSaving ? t('saving_btn') : t('save_summary_btn')}
          </button>
          <button className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      )}
    </div>
  );
}
