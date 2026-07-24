import type { ProviderModelOption } from "../api/types.js";

export type ToolSupport = "supported" | "unknown" | "unsupported";

export interface ProviderModel extends ProviderModelOption {
  toolSupport: ToolSupport;
}

/**
 * Derive the owner/vendor of a model for "Group by owner" (SillyTavern parity).
 *
 * VT cannot key this on the provider type — every aggregator (OpenRouter,
 * Chutes, NanoGPT, ElectronHub) reports `providerType: "openai_compat"`
 * (`packages/domain/src/provider-support.ts`). So this mirrors ST's
 * `groupModelsByVendor` rules in priority order against the id/label instead:
 *   1. `/`-prefix in the id  — OpenRouter / Chutes / NanoGPT ("anthropic/claude" → "anthropic")
 *   2. `:`-prefix in the label — ElectronHub ("OpenAI:gpt-4o" → "OpenAI")
 *   3. `-`-prefix in the id   — NanoGPT dashed ids without a slash ("deepseek-2" → "deepseek")
 *   4. fallback              — "Other"
 */
export function deriveOwner(model: Pick<ProviderModelOption, "id" | "label">): string {
  const slashIdx = model.id.indexOf("/");
  if (slashIdx > 0) return model.id.slice(0, slashIdx);
  if (model.label) {
    const colonIdx = model.label.indexOf(":");
    if (colonIdx > 0) return model.label.slice(0, colonIdx);
  }
  const dashIdx = model.id.indexOf("-");
  if (dashIdx > 0) return model.id.slice(0, dashIdx);
  return "Other";
}

/**
 * "Free only" predicate — computed LIVE against fetched/cached pricing each
 * render, never persisted as a tag (OpenRouter rotates temporarily-free models,
 * so a stored tag would go stale). A model is free when both input and output
 * pricing are exactly 0; missing pricing is treated as NOT free (unknown cost).
 */
export function isFreeModel(model: Pick<ProviderModelOption, "pricing">): boolean {
  return model.pricing?.input === 0 && model.pricing?.output === 0;
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
