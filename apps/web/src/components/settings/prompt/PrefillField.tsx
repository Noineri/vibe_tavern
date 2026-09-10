import { useT } from "../../../i18n/context.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { cn } from "../../../lib/cn.js";
import { lblCls, textareaCls } from "../../../lib/field-tokens.js";

interface PrefillFieldProps {
  prefill: string;
  onUpdate: (value: string) => void;
  disabled?: boolean;
  prefillSupported?: boolean;
}

export function PrefillField({ prefill, onUpdate, disabled, prefillSupported }: PrefillFieldProps) {
  const { t } = useT();
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <label className={cn(lblCls, "!mb-0")}>
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
      <MobileExpandTextarea value={prefill} onChange={onUpdate} label={t("prefill_assistant")}>
        <AutoTextarea
          className={cn(textareaCls, "disabled:opacity-60")}
          maxRows={15}
          minRows={3}
          value={prefill}
          onChange={(e) => onUpdate(e.target.value)}
          disabled={disabled}
          placeholder={t("prefill_placeholder")}
        />
      </MobileExpandTextarea>
    </div>
  );
}
