import { lblCls } from "../../../lib/field-tokens.js";
import { Toggle } from "../../shared/Toggle.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";

interface LorebookActivationSettingsProps {
  includeNames: boolean;
  characterStrategy: number;
  t: TFunc;
  onUpdateMeta: (body: { includeNames?: boolean; characterStrategy?: number }) => void;
}

export function LorebookActivationSettings({
  includeNames,
  characterStrategy,
  t,
  onUpdateMeta,
}: LorebookActivationSettingsProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">
          {t("lore_include_names")}
        </span>
        <Toggle
          checked={includeNames}
          onChange={(value) => onUpdateMeta({ includeNames: value })}
          aria-label={t("lore_include_names")}
        />
      </div>
      <div>
        <label className={lblCls}>{t("lore_character_strategy")}</label>
        <SegmentedControl
          value={characterStrategy === 0 ? "0" : characterStrategy === 2 ? "2" : "1"}
          options={[
            { value: "0", label: t("lore_character_strategy_evenly") },
            { value: "1", label: t("lore_character_strategy_character_first") },
            { value: "2", label: t("lore_character_strategy_global_first") },
          ]}
          onChange={(value) => onUpdateMeta({
            characterStrategy: value === "0" ? 0 : value === "2" ? 2 : 1,
          })}
          ariaLabel={t("lore_character_strategy")}
          fill
          mobileSelect
        />
      </div>
    </>
  );
}
