import type {
  ImagePromptProfileRuntimeApi,
} from "../contract/runtime-api.js";
import type { AppDb } from "@vibe-tavern/db";
import { ImagePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import { IMAGE_GENERATION_MODES, IMAGE_PROMPT_DEFAULT_FAMILY, IMAGE_PROMPT_FAMILIES } from "@vibe-tavern/domain";
import { buildProfileTemplateCatalog, type ImagePromptProfileOverridesMap } from "../../domain/imagegen/prompt-template-catalog.js";
import { ImageGenValidationError } from "./image-gen-adapter.js";
import type {
  ImagePromptProfileValue,
  ImagePromptProfileListResponse,
  ImagePromptProfileDetailResponse,
  CreateImagePromptProfileRequest,
  UpdateImagePromptProfileRequest,
} from "@vibe-tavern/api-contracts";

/**
 * Thin adapter between the `ImagePromptProfileRuntimeApi` contract and the
 * `@vibe-tavern/db` stores (IF-1b — a fork of `ServicePromptAdapter` with
 * the field axis swapped to (rowKey|family) cells).
 *
 * Owns:
 *  - listing + detail (with the profile-scoped template catalog)
 *  - create / update / delete (forbidden on the built-in Default profile)
 *  - active-pointer put via uiSettings (activeImagePromptProfileId)
 *
 * Cell semantic guards on whole-profile saves (the same rules the per-cell
 * IPT-3 upsert enforces, applied per key): a (free, non-prose) cell would be
 * unreachable by generation and is refused; a qualityText on a
 * non-quality-authoring family is refused. Both throw ImageGenValidationError
 * (the route maps them to 400) naming the offending cell key.
 */
export class ImagePromptProfileAdapter implements ImagePromptProfileRuntimeApi {
  constructor(private readonly stores: { db: AppDb }) {}

  listImagePromptProfiles = async (): Promise<ImagePromptProfileListResponse> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const [profiles, settings] = await Promise.all([
      profileStore.listImagePromptProfiles(),
      uiSettingsStore.get(),
    ]);
    return {
      profiles: profiles.map(toWire),
      activeProfileId: settings.activeImagePromptProfileId,
    };
  };

  getImagePromptProfile = async (id: string): Promise<ImagePromptProfileDetailResponse | null> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const profile = await profileStore.getImagePromptProfile(id);
    if (!profile) return null;
    const catalog = await buildProfileTemplateCatalog(profile.overrides);
    return { profile: toWire(profile), catalog };
  };

  createImagePromptProfile = async (body: CreateImagePromptProfileRequest): Promise<ImagePromptProfileValue> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const row = await profileStore.createImagePromptProfile({
      name: body.name,
      overrides: validateCells(body.overrides ?? {}),
    });
    return toWire(row);
  };

  updateImagePromptProfile = async (
    id: string,
    body: UpdateImagePromptProfileRequest,
  ): Promise<{ status: "ok"; profile: ImagePromptProfileValue } | { status: "not-found" } | { status: "forbidden" }> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const existing = await profileStore.getImagePromptProfile(id);
    if (!existing) return { status: "not-found" };
    if (existing.isDefault) return { status: "forbidden" };
    const updated = await profileStore.updateImagePromptProfile(id, {
      name: body.name,
      overrides: body.overrides === undefined ? undefined : validateCells(body.overrides),
    });
    if (!updated) return { status: "not-found" };
    return { status: "ok", profile: toWire(updated) };
  };

  deleteImagePromptProfile = async (id: string): Promise<{ status: "ok" } | { status: "not-found" } | { status: "forbidden" }> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const existing = await profileStore.getImagePromptProfile(id);
    if (!existing) return { status: "not-found" };
    if (existing.isDefault) return { status: "forbidden" };
    await profileStore.deleteImagePromptProfile(id);
    const settings = await uiSettingsStore.get();
    if (settings.activeImagePromptProfileId === id) {
      await uiSettingsStore.update({ activeImagePromptProfileId: null });
    }
    return { status: "ok" };
  };

  setActiveImagePromptProfile = async (profileId: string | null): Promise<{ status: "ok" } | { status: "not-found" }> => {
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    if (profileId !== null) {
      const profileStore = new ImagePromptProfileStore(this.stores.db);
      const exists = await profileStore.getImagePromptProfile(profileId);
      if (!exists) return { status: "not-found" };
    }
    await uiSettingsStore.update({ activeImagePromptProfileId: profileId });
    return { status: "ok" };
  };

  reorderImagePromptProfiles = async (
    updates: Array<{ id: string; sortOrder: number }>,
  ): Promise<ImagePromptProfileListResponse> => {
    const profileStore = new ImagePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const profiles = await profileStore.reorderImagePromptProfiles(updates);
    const settings = await uiSettingsStore.get();
    return { profiles: profiles.map(toWire), activeProfileId: settings.activeImagePromptProfileId };
  };
}

function toWire(row: {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  overrides: ImagePromptProfileOverridesMap;
  createdAt: string;
  updatedAt: string;
}): ImagePromptProfileValue {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    overrides: row.overrides,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Per-cell semantic guards + quality normalization on whole-profile saves.
 *  Mirrors the IPT-3 upsert guards: refuse (free, non-prose) cells (dead
 *  data — unreachable by generation) and qualityText on families that author
 *  no quality layer; trim-empty quality normalizes to null (clear), like the
 *  profile PATCH null-clear convention. */
function validateCells(overrides: ImagePromptProfileOverridesMap): ImagePromptProfileOverridesMap {
  const out: ImagePromptProfileOverridesMap = {};
  for (const [key, cell] of Object.entries(overrides) as Array<[keyof ImagePromptProfileOverridesMap, { body: string; qualityText?: string | null }]>) {
    const [rowKey, family] = key.split("|") as [string, string];
    if (rowKey === IMAGE_GENERATION_MODES.Free && family !== IMAGE_PROMPT_DEFAULT_FAMILY) {
      throw new ImageGenValidationError(
        `Free mode is family-neutral: customize its shared prose template instead of the '${family}' variant (cell '${key}').`,
      );
    }
    let qualityText = cell.qualityText ?? null;
    // Normalize BEFORE the authorship guard: a blank/whitespace quality is a
    // CLEAR (back to canon), harmless on any family — same convention as the
    // IPT-3 upsert boundary.
    if (qualityText !== null && qualityText.trim() === "") qualityText = null;
    if (qualityText !== null && !IMAGE_PROMPT_FAMILIES[family as keyof typeof IMAGE_PROMPT_FAMILIES].ownQuality) {
      throw new ImageGenValidationError(
        `The '${family}' family has no quality layer; quality text cannot be set for it (cell '${key}').`,
      );
    }
    out[key] = { body: cell.body, qualityText };
  }
  return out;
}
