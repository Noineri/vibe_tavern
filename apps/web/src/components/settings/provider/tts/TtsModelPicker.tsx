import { useT } from "../../../../i18n/context.js";
import { ProviderModelSelector } from "../ProviderModelSelector.js";
import type { ProviderModelListOption } from "../ProviderModelList.js";

/** Row option for the TTS model catalog, including aggregator enrichment. */
export interface TtsModelOption {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
  contextLength?: number;
}

interface TtsModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  models: TtsModelOption[];
  fetching: boolean;
  fetchError: string | null;
  onRefresh: () => void;
  label: string;
}

/** TTS configuration adapter around the shared model-selector source. */
export function TtsModelPicker({
  value,
  onChange,
  models,
  fetching,
  fetchError,
  onRefresh,
  label,
}: TtsModelPickerProps) {
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
      triggerTestId="tts-field-model"
      refreshTestId="tts-models-refresh"
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
