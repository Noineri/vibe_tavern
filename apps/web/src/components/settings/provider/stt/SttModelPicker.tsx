import { useT } from "../../../../i18n/context.js";
import { ProviderModelSelector } from "../ProviderModelSelector.js";
import type { ProviderModelListOption } from "../ProviderModelList.js";

/** Row option for the STT model catalog, including aggregator enrichment. */
export interface SttModelOption {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
}

interface SttModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  models: SttModelOption[];
  fetching: boolean;
  fetchError: string | null;
  /** Refresh handler for fetched catalogs; omitted for static native rosters. */
  onRefresh?: () => void;
  label: string;
}

/** STT configuration adapter around the shared model-selector source. */
export function SttModelPicker({
  value,
  onChange,
  models,
  fetching,
  fetchError,
  onRefresh,
  label,
}: SttModelPickerProps) {
  const { t } = useT();

  return (
    <ProviderModelSelector
      value={value}
      onChange={onChange}
      options={models as ProviderModelListOption[]}
      fetching={fetching}
      fetchError={fetchError}
      onRefreshOptions={onRefresh}
      keepDropdownWhenOptionsEmpty
      emptyOptionsLabel={t("tts_models_loading")}
      triggerTestId="stt-field-model"
      refreshTestId="stt-models-refresh"
      label={label}
      showPricing={false}
      renderRowBadges={(model) => model.isFree ? (
        <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">free</span>
      ) : null}
      renderRowDescription={(model) => model.description ? (
        <div className="mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-t4">{model.description}</div>
      ) : null}
    />
  );
}
