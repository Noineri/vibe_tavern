import { useT } from "../../../i18n/context.js";
import { ProviderModelSelector, type ProviderModelSelectorProps } from "./ProviderModelSelector.js";

/** Keep the vision subset distinct from the catalog used to identify missing favorites. */
export function ProviderVisionModelSelector({ options, ...props }: ProviderModelSelectorProps) {
  const { t } = useT();
  return (
    <ProviderModelSelector
      {...props}
      options={options.filter((model) => model.capabilities?.vision)}
      catalogOptions={options}
      label={t("vision_fallback_model")}
      placeholder={t("select_vision_model")}
      showRefreshButton={false}
      showContextLength={false}
    />
  );
}
