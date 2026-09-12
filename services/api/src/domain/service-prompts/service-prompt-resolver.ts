import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import type { AppDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore } from "@vibe-tavern/db";
import type { ServicePromptProfile } from "@vibe-tavern/db";
import { UiSettingsStore } from "@vibe-tavern/db";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";
import { getServicePromptAssetFile } from "./service-prompt-registry.js";

/**
 * Full resolution order for base service prompts:
 *
 * 1. Per-chat overrides (insights only) — applied by consumers BEFORE calling
 *    this module (see SP-5 tracker-service wiring). This module starts at the
 *    next tier.
 * 2. Active service-prompt profile override — when the active profile
 *    (`uiSettings.activeServicePromptProfileId`) has a non-empty override for
 *    the field, that text wins. The Default profile has empty overrides, so
 *    it naturally falls through.
 * 3. Default asset ladder — `loadPromptAsset(getServicePromptAssetFile(field))`
 *    (env override → exe-adjacent → source assets → out).
 */

export async function getActiveServicePromptProfile(
  db: AppDb,
): Promise<{ profile: ServicePromptProfile }> {
  const uiSettingsStore = new UiSettingsStore(db);
  const profileStore = new ServicePromptProfileStore(db);

  const settings = await uiSettingsStore.get();
  const activeId = settings.activeServicePromptProfileId;

  if (activeId) {
    const active = await profileStore.getServicePromptProfile(activeId);
    if (active) return { profile: active };
  }

  // Null or dangling → Default (self-heals if the row is missing).
  const def = await profileStore.ensureDefaultServicePromptProfile();
  return { profile: def };
}

export async function resolveServicePrompt(
  db: AppDb,
  field: ServicePromptFieldKey,
): Promise<{ text: string; source: "override" | "default" }> {
  const { profile } = await getActiveServicePromptProfile(db);
  const raw = profile.overrides[field];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 0) {
    return { text: trimmed, source: "override" };
  }
  const text = await loadPromptAsset(getServicePromptAssetFile(field));
  return { text, source: "default" };
}

export async function resolveServicePromptDefaultPreview(
  field: ServicePromptFieldKey,
): Promise<string> {
  return loadPromptAsset(getServicePromptAssetFile(field));
}

export async function resolveServicePromptText(
  db: AppDb,
  field: ServicePromptFieldKey,
): Promise<string> {
  const res = await resolveServicePrompt(db, field);
  return res.text;
}
