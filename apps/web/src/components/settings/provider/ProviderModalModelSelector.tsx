import { resolveModelContextBudget, RP_UNKNOWN_CONTEXT_BUDGET } from "../../../lib/context-autofill.js";
import { ProviderModelSelector } from "./ProviderModelSelector.js";
import type { ProviderModelListOption } from "./ProviderModelList.js";
import type { LocalConnectionStatus } from "../../shared/LocalConnectionStatus.js";

export interface ProviderModelSelectorValues {
  model: string;
  contextBudget: number;
  pinContextBudget: boolean;
  modelFreeOnly: boolean;
  modelGroupByOwner: boolean;
}

interface ProviderModalModelSelectorProps {
  values: ProviderModelSelectorValues;
  options: ProviderModelListOption[];
  fetching: boolean;
  fetchError: string | null;
  favoriteModels: Array<{ modelId: string; label: string | null; contextLength: number | null }>;
  onChange: (key: "model" | "contextBudget" | "modelFreeOnly" | "modelGroupByOwner", value: string | number | boolean) => void;
  onRefreshOptions: () => void;
  onToggleFavoriteModel: (model: ProviderModelListOption) => void;
  requiresAuthForModels: boolean;
  localEndpoint?: string;
  localConnectionStatus?: LocalConnectionStatus;
}

/** RP-specific persistence and context-budget policy around the family source. */
export function ProviderModalModelSelector({
  values,
  options,
  fetching,
  fetchError,
  favoriteModels,
  onChange,
  onRefreshOptions,
  onToggleFavoriteModel,
  requiresAuthForModels,
  localEndpoint,
  localConnectionStatus,
}: ProviderModalModelSelectorProps) {
  return (
    <ProviderModelSelector
      value={values.model}
      onChange={(value) => onChange("model", value)}
      onOptionSelected={(model) => {
        const contextBudget = resolveModelContextBudget({
          pinned: values.pinContextBudget,
          contextLength: model.contextLength,
          currentBudget: values.contextBudget,
          unknownContextBudget: RP_UNKNOWN_CONTEXT_BUDGET,
        });
        if (contextBudget !== undefined) onChange("contextBudget", contextBudget);
      }}
      options={options}
      fetching={fetching}
      fetchError={fetchError}
      onRefreshOptions={onRefreshOptions}
      favoriteModels={favoriteModels}
      onToggleFavoriteModel={onToggleFavoriteModel}
      freeOnly={{ checked: values.modelFreeOnly, onChange: (value) => onChange("modelFreeOnly", value) }}
      groupByOwner={{ checked: values.modelGroupByOwner, onChange: (value) => onChange("modelGroupByOwner", value) }}
      requiresAuthForModels={requiresAuthForModels}
      localConnection={localConnectionStatus ? { endpoint: localEndpoint ?? "", status: localConnectionStatus } : undefined}
    />
  );
}
