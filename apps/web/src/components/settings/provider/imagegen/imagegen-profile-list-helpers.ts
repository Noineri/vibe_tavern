import { IMAGE_GEN_PROVIDER_PRESETS } from "../../../../provider-presets.js";

/** The user-visible preset label for an ImageGen profile row and its search. */
export function getImageGenProfilePresetLabel(backend: string, presetId: string | null | undefined): string {
  const preset = presetId !== null && presetId !== undefined
    ? IMAGE_GEN_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId)
    : undefined;
  return preset?.label ?? backend;
}
