import type { ImageGenBackendType } from "@vibe-tavern/domain";
import type {
  ImageGenCapabilityFlagsValue,
  ImageGenDefaultParamsValue,
  ImageGenModeSizePresetsValue,
  ImageGenProfileValue,
  ImageGenUserSizeEntryValue,
} from "@vibe-tavern/api-contracts";
import { toImageGenBackend } from "../components/settings/provider/imagegen/imagegen-form-helpers.js";

/** Editor form — the wire record's editable fields plus the write-only key. */
export interface ImageGenProfileForm {
  id: string | null;
  name: string;
  backend: ImageGenBackendType;
  presetId: string | null;
  endpoint: string;
  apiKey: string;
  hasStoredApiKey: boolean;
  autoKeyProviderName: string | null;
  modelId: string | null;
  defaultParams: ImageGenDefaultParamsValue;
  defaultParamsSetId: string | null;
  modeSizePresets: ImageGenModeSizePresetsValue;
  userSizes: ImageGenUserSizeEntryValue[];
  llmAssistEnabled: boolean;
  llmProviderProfileId: string | null;
  llmModelId: string | null;
  assistRetryOnRefusal: boolean;
  capabilities: ImageGenCapabilityFlagsValue;
}

/** Hydrate an editable form without ever exposing a stored API key. */
export function hydrateImageGenProfile(record: ImageGenProfileValue): ImageGenProfileForm {
  return {
    id: record.id,
    name: record.name,
    backend: toImageGenBackend(record.backend),
    presetId: record.presetId ?? null,
    endpoint: record.endpoint,
    apiKey: "",
    hasStoredApiKey: record.hasStoredApiKey,
    autoKeyProviderName: record.autoKeyProviderName ?? null,
    modelId: record.modelId ?? null,
    defaultParams: { ...record.defaultParams },
    defaultParamsSetId: record.defaultParamsSetId ?? null,
    modeSizePresets: { ...record.modeSizePresets },
    userSizes: record.userSizes !== undefined ? record.userSizes.map((entry) => ({ ...entry })) : [],
    llmAssistEnabled: record.llmAssistEnabled,
    llmProviderProfileId: record.llmProviderProfileId ?? null,
    llmModelId: record.llmModelId ?? null,
    assistRetryOnRefusal: record.assistRetryOnRefusal,
    capabilities: { ...record.capabilities },
  };
}
