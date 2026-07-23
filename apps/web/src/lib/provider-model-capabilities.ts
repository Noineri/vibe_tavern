import type { ProviderModelOption } from "../api/types.js";

export type ToolSupport = "supported" | "unknown" | "unsupported";

export interface ProviderModel extends ProviderModelOption {
  toolSupport: ToolSupport;
}

type CachedCapabilityShape = {
  reasoning?: boolean;
  thinking?: boolean;
  tools?: boolean;
  vision?: boolean;
  webSearch?: boolean;
  premium?: boolean;
};

type ModelLike = Omit<ProviderModelOption, "capabilities"> & {
  capabilities?: CachedCapabilityShape;
};

export function getToolSupport(tools: boolean | undefined): ToolSupport {
  if (tools === true) return "supported";
  if (tools === false) return "unsupported";
  return "unknown";
}

/** Normalizes live and legacy cached records without dropping model metadata. */
export function normalizeProviderModel(model: ModelLike): ProviderModel {
  const capabilities = model.capabilities && {
    ...(model.capabilities.reasoning !== undefined
      ? { reasoning: model.capabilities.reasoning }
      : model.capabilities.thinking !== undefined
        ? { reasoning: model.capabilities.thinking }
        : {}),
    ...(model.capabilities.tools !== undefined ? { tools: model.capabilities.tools } : {}),
    ...(model.capabilities.vision !== undefined ? { vision: model.capabilities.vision } : {}),
    ...(model.capabilities.webSearch !== undefined ? { webSearch: model.capabilities.webSearch } : {}),
    ...(model.capabilities.premium !== undefined ? { premium: model.capabilities.premium } : {}),
  };

  return {
    ...model,
    ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    toolSupport: getToolSupport(capabilities?.tools),
  };
}
