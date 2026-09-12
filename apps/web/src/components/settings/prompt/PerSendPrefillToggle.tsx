import { useT } from "../../../i18n/context.js";
import { Toggle } from "../../shared/Toggle.js";

/**
 * Per-send prefill entry-point toggle row (LS-8, owner design 2026-09-09).
 *
 * One shared row, two homes: beside the prefill field in the simple editor
 * (PromptFields) and INSIDE the prefill accordion card in the advanced canvas
 * (build-fixed-items → CanvasCard expandedTrailing). Off = the chip/bubble/
 * strip render nowhere. The preset's persistent prefill value is untouched.
 */
interface PerSendPrefillToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function PerSendPrefillToggle({ checked, onChange, disabled }: PerSendPrefillToggleProps) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3">
      <Toggle
        checked={checked}
        onChange={(v) => onChange(v)}
        disabled={disabled}
        className="!mb-0 !inline-flex"
      />
      <div className="min-w-0">
        <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("per_send_prefill_enable")}</div>
        <div className="font-ui text-[11px] text-t3">{t("per_send_prefill_enable_hint")}</div>
      </div>
    </div>
  );
}
