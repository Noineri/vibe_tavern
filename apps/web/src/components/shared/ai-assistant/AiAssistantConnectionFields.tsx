import { DropdownSelect } from "../DropdownSelect.js";

export interface AiAssistantConnectionFieldsProps {
  providerProfiles: Array<{ id: string; name: string }>;
  providerId: string;
  modelName: string;
  providerModels: Array<{ id: string; label?: string }>;
  selectedProfileDefaultModel: string | null;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  labels: {
    connection: string;
    model: string;
    selectProvider: string;
    searchProvider: string;
    searchModel: string;
  };
}

export function AiAssistantConnectionFields({
  providerProfiles,
  providerId,
  modelName,
  providerModels,
  selectedProfileDefaultModel,
  onProviderChange,
  onModelChange,
  labels,
}: AiAssistantConnectionFieldsProps) {
  const defaultOption = selectedProfileDefaultModel || "Default";

  return (
    <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
      <div>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {labels.connection}
        </label>
        <DropdownSelect
          value={providerId}
          options={providerProfiles.map((p) => ({ id: p.id, label: p.name }))}
          placeholder={labels.selectProvider}
          searchPlaceholder={labels.searchProvider}
          onChange={onProviderChange}
        />
      </div>
      <div>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {labels.model}
        </label>
        <DropdownSelect
          value={modelName}
          options={providerModels.map((m) => ({ id: m.id, label: m.label || m.id }))}
          placeholder={defaultOption}
          searchPlaceholder={labels.searchModel}
          defaultOption={defaultOption}
          onChange={onModelChange}
          disabled={!providerId}
        />
      </div>
    </div>
  );
}
