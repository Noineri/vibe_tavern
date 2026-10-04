import { cn } from "../../../lib/cn.js";
import { DropdownSelect } from "../DropdownSelect.js";
import { Ic } from "../icons.js";
import { Toggle } from "../Toggle.js";

type ProviderProfile = {
  id: string;
  name: string;
  defaultModel?: string | null;
  isActive?: boolean;
};

type ProviderModel = {
  id: string;
  label?: string;
  detail?: string;
};

interface UseChatModelOption {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  /** Summary keeps its saved model visible while the chat fallback is active. */
  visibleModel?: "chat-default" | "provided";
}

interface ModelPinOption {
  pinned: boolean;
  onChange: (nextPinned: boolean, value: { providerId: string; modelName: string }) => void;
  pinLabel: string;
  unpinLabel: string;
  disabled?: boolean;
  disabledClassName?: boolean;
  /** Summary's persisted pin intentionally overrides the chat-model fallback. */
  overridesChatModel?: boolean;
}

export interface AiAssistantConnectionFieldsProps {
  providerProfiles: ProviderProfile[];
  providerId: string;
  modelName: string;
  providerModels: ProviderModel[];
  selectedProfileDefaultModel?: string | null;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  /** Disables both selectors without changing existing consumers' behavior. */
  disabled?: boolean;
  /** Opt-in secondary-model mode: the chat profile supplies the active connection. */
  useChatModel?: UseChatModelOption;
  /** Opt-in model pin control beside the model selector. */
  modelPin?: ModelPinOption;
  /** Secondary-model consumers preserve their own loading lifecycle. */
  loadingModels?: boolean;
  /** Existing assistant consumers retain their labeled fields by default. */
  showLabels?: boolean;
  /** Existing assistant consumers retain the default-model menu option by default. */
  includeDefaultOption?: boolean;
  /** Opt-in fallback to the selected profile default when no secondary model is pinned. */
  resolveProfileDefaultModel?: boolean;
  /** Secondary-model rows retain their compact two-column gap. */
  compact?: boolean;
  /** Existing assistant consumers retain their lower spacing by default. */
  withBottomMargin?: boolean;
  labels: {
    connection: string;
    model: string;
    selectProvider: string;
    searchProvider: string;
    searchModel: string;
    modelPlaceholder?: string;
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
  disabled = false,
  useChatModel,
  modelPin,
  loadingModels = false,
  showLabels = true,
  includeDefaultOption = true,
  resolveProfileDefaultModel = false,
  compact = false,
  withBottomMargin = true,
  labels,
}: AiAssistantConnectionFieldsProps) {
  const activeProfile = providerProfiles.find((profile) => profile.isActive) ?? providerProfiles[0] ?? null;
  const selectedProfile = providerProfiles.find((profile) => profile.id === providerId) ?? null;
  const resolvedProfile = useChatModel?.checked ? activeProfile : selectedProfile;
  const resolvedProviderId = resolvedProfile?.id ?? providerId;
  const resolvedModelName = (
    useChatModel?.checked
      ? (useChatModel.visibleModel === "provided" || modelPin?.pinned && modelPin.overridesChatModel ? modelName : resolvedProfile?.defaultModel ?? "")
      : (resolveProfileDefaultModel ? modelName || resolvedProfile?.defaultModel || "" : modelName)
  ).trim();
  const defaultOption = selectedProfileDefaultModel || "Default";

  const providerPicker = (
    <DropdownSelect
      value={resolvedProviderId}
      options={providerProfiles.map((profile) => ({ id: profile.id, label: profile.name }))}
      placeholder={labels.selectProvider}
      searchPlaceholder={labels.searchProvider}
      onChange={onProviderChange}
      disabled={disabled || useChatModel?.checked}
    />
  );
  const modelPicker = (
    <DropdownSelect
      value={resolvedModelName}
      options={providerModels.map((model) => ({ id: model.id, label: model.label || model.id, detail: model.detail }))}
      placeholder={loadingModels ? "…" : labels.modelPlaceholder ?? (includeDefaultOption ? defaultOption : labels.model)}
      searchPlaceholder={labels.searchModel}
      defaultOption={includeDefaultOption ? defaultOption : undefined}
      onChange={onModelChange}
      disabled={disabled || useChatModel?.checked || !resolvedProviderId || loadingModels}
    />
  );

  const fields = showLabels ? (
    <>
      <div>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {labels.connection}
        </label>
        {providerPicker}
      </div>
      <div>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {labels.model}
        </label>
        <div className={cn(modelPin && "flex items-center gap-1.5")}>
          {modelPicker}
          {modelPin && <ModelPinButton pin={modelPin} providerId={resolvedProviderId} modelName={resolvedModelName} />}
        </div>
      </div>
    </>
  ) : (
    <>
      {providerPicker}
      <div className={cn(modelPin && "flex items-center gap-1.5")}>
        {modelPicker}
        {modelPin && <ModelPinButton pin={modelPin} providerId={resolvedProviderId} modelName={resolvedModelName} />}
      </div>
    </>
  );
  // MUI step 17 (owner 2026-09-11): provider + model stack into a list on
  // mobile — same grid→list rule as the tracker pickers (steps 10/11).
  const fieldsGrid = (
    <div className={cn("grid grid-cols-2 max-md:grid-cols-1", compact ? "gap-2" : "gap-3")} style={withBottomMargin ? { marginBottom: 16 } : undefined}>
      {fields}
    </div>
  );

  if (!useChatModel) return fieldsGrid;
  return (
    <div>
      <label className={useChatModel.className ?? "mb-2 mt-1.5 flex items-center gap-2 font-ui text-[12px] text-t2"}>
        <Toggle checked={useChatModel.checked} onChange={useChatModel.onChange} disabled={useChatModel.disabled} />
        {useChatModel.label}
      </label>
      {fieldsGrid}
    </div>
  );
}

function ModelPinButton({ pin, providerId, modelName }: { pin: ModelPinOption; providerId: string; modelName: string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
        pin.disabledClassName && "disabled:pointer-events-none disabled:opacity-40",
        pin.pinned ? "border-accent bg-accent-dim text-accent" : "border-border text-t4 hover:text-t3",
      )}
      title={pin.pinned ? pin.unpinLabel : pin.pinLabel}
      onClick={() => pin.onChange(!pin.pinned, { providerId, modelName })}
      disabled={pin.disabled}
    >
      {pin.pinned ? <Ic.starFilled /> : <Ic.star />}
    </button>
  );
}
