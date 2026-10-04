import type { Dispatch, SetStateAction } from "react";
import { COAUTHOR_UNKNOWN_CONTEXT_BUDGET } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { resolveModelContextBudget } from "../../../lib/context-autofill.js";
import { ProviderModelSelector } from "./ProviderModelSelector.js";
import type { ProviderModelListOption } from "./ProviderModelList.js";

export interface CoauthorModelSelectorValues {
  model: string;
  contextBudget: number;
  pinContextBudget: boolean;
}

interface CoauthorModelSelectorProps {
  values: CoauthorModelSelectorValues;
  models: ProviderModelListOption[];
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  favoriteModels: Array<{ modelId: string; label: string | null; contextLength: number | null }>;
  onChange: (key: "model" | "contextBudget", value: string | number) => void;
  onFetchModels: () => void;
  setModelSearch: (value: string) => void;
  setModelListOpen: Dispatch<SetStateAction<boolean>>;
  onToggleFavoriteModel: (model: ProviderModelListOption) => void;
}

/** Co-Author context-budget policy around the shared model-selector source. */
export function CoauthorModelSelector({
  values,
  models,
  fetching,
  fetchError,
  modelSearch,
  modelListOpen,
  favoriteModels,
  onChange,
  onFetchModels,
  setModelSearch,
  setModelListOpen,
  onToggleFavoriteModel,
}: CoauthorModelSelectorProps) {
  const { t } = useT();
  const syncContextBudget = (contextLength: number | null | undefined) => {
    const contextBudget = resolveModelContextBudget({
      pinned: values.pinContextBudget,
      contextLength,
      currentBudget: values.contextBudget,
      unknownContextBudget: COAUTHOR_UNKNOWN_CONTEXT_BUDGET,
    });
    if (contextBudget !== undefined) onChange("contextBudget", contextBudget);
  };

  return (
    <ProviderModelSelector
      value={values.model}
      onChange={(value) => onChange("model", value)}
      options={models}
      fetching={fetching}
      fetchError={fetchError}
      onRefreshOptions={onFetchModels}
      favoriteModels={favoriteModels}
      onToggleFavoriteModel={onToggleFavoriteModel}
      onOptionSelected={(model) => syncContextBudget(model.contextLength)}
      onCustomIdSelected={() => syncContextBudget(undefined)}
      label={t("coauthor.provider.model_label")}
      modelSearch={modelSearch}
      onModelSearchChange={setModelSearch}
      modelListOpen={modelListOpen}
      onModelListOpenChange={setModelListOpen}
      refreshTestId="coauthor-models-refresh"
    />
  );
}
