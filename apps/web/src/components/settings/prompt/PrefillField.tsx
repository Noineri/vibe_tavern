import { useT } from "../../../i18n/context.js";

interface PrefillFieldProps {
  prefill: string;
  onUpdate: (value: string) => void;
  disabled?: boolean;
  prefillSupported?: boolean;
}

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none disabled:opacity-60";

export function PrefillField({ prefill, onUpdate, disabled, prefillSupported }: PrefillFieldProps) {
  const { t } = useT();
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
          {t("prefill_assistant")}
        </label>
        {prefillSupported && (
          <span className="flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-4px)] text-success">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t("prefill_supported_badge")}
          </span>
        )}
      </div>
      <textarea
        className={textareaCls + " px-[13px] py-[9px] min-h-[60px]"}
        value={prefill}
        onChange={(e) => onUpdate(e.target.value)}
        disabled={disabled}
        placeholder={t("prefill_placeholder")}
      />
    </div>
  );
}
