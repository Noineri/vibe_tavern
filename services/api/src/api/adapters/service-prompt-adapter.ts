import type {
  ServicePromptRuntimeApi,
  ServicePromptUpdateResult,
  ServicePromptDeleteResult,
  ServicePromptSetActiveResult,
} from "../contract/runtime-api.js";
import type { AppDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import { resolveServicePromptDefaultPreview } from "../../domain/service-prompts/service-prompt-resolver.js";
import type {
  ServicePromptProfile,
  ServicePromptProfileListResponse,
  ServicePromptProfileDetailResponse,
  CreateServicePromptProfileRequest,
  UpdateServicePromptProfileRequest,
} from "@vibe-tavern/api-contracts";

/**
 * Thin adapter between the `ServicePromptRuntimeApi` contract and the
 * `@vibe-tavern/db` stores (SERVICE_PROMPTS_PROFILES_PLAN, SP-6).
 *
 * Owns:
 *  - listing + detail (with per-field resolved defaults for the live Default view)
 *  - create / update / delete (forbidden on the built-in Default profile)
 *  - active-pointer put via uiSettings
 *
 * Default-guard semantics: the underlying store silently ignores mutations on
 * the Default profile, so the adapter explicitly checks `existing.isDefault`
 * (after the store's self-healing get — the Default row always resolves) and
 * returns a discriminated result the route maps to the correct HTTP status.
 */
export class ServicePromptAdapter implements ServicePromptRuntimeApi {
  constructor(private readonly stores: { db: AppDb }) {}

  listServicePromptProfiles = async (): Promise<ServicePromptProfileListResponse> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const [profiles, settings] = await Promise.all([
      profileStore.listServicePromptProfiles(),
      uiSettingsStore.get(),
    ]);
    const wireProfiles: ServicePromptProfile[] = profiles.map(toWire);
    return {
      profiles: wireProfiles,
      activeProfileId: settings.activeServicePromptProfileId,
    };
  };

  getServicePromptProfile = async (id: string): Promise<ServicePromptProfileDetailResponse | null> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const profile = await profileStore.getServicePromptProfile(id);
    if (!profile) return null;
    const wire = toWire(profile);
    const resolved = await buildResolvedMap(profile.overrides);
    return { profile: wire, resolved };
  };

  createServicePromptProfile = async (body: CreateServicePromptProfileRequest): Promise<ServicePromptProfile> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const row = await profileStore.createServicePromptProfile({
      name: body.name,
      overrides: body.overrides,
    });
    return toWire(row);
  };

  updateServicePromptProfile = async (
    id: string,
    body: UpdateServicePromptProfileRequest,
  ): Promise<ServicePromptUpdateResult> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const existing = await profileStore.getServicePromptProfile(id);
    if (!existing) return { status: "not-found" };
    if (existing.isDefault) return { status: "forbidden" };
    const updated = await profileStore.updateServicePromptProfile(id, {
      name: body.name,
      overrides: body.overrides,
    });
    if (!updated) return { status: "not-found" };
    return { status: "ok", profile: toWire(updated) };
  };

  deleteServicePromptProfile = async (id: string): Promise<ServicePromptDeleteResult> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const existing = await profileStore.getServicePromptProfile(id);
    if (!existing) return { status: "not-found" };
    if (existing.isDefault) return { status: "forbidden" };
    await profileStore.deleteServicePromptProfile(id);
    const settings = await uiSettingsStore.get();
    if (settings.activeServicePromptProfileId === id) {
      await uiSettingsStore.update({ activeServicePromptProfileId: null });
    }
    return { status: "ok" };
  };

  setActiveServicePromptProfile = async (profileId: string | null): Promise<ServicePromptSetActiveResult> => {
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    if (profileId !== null) {
      const profileStore = new ServicePromptProfileStore(this.stores.db);
      const exists = await profileStore.getServicePromptProfile(profileId);
      if (!exists) return { status: "not-found" };
    }
    await uiSettingsStore.update({ activeServicePromptProfileId: profileId });
    return { status: "ok" };
  };

  reorderServicePromptProfiles = async (
    updates: Array<{ id: string; sortOrder: number }>,
  ): Promise<ServicePromptProfileListResponse> => {
    const profileStore = new ServicePromptProfileStore(this.stores.db);
    const uiSettingsStore = new UiSettingsStore(this.stores.db);
    const profiles = await profileStore.reorderServicePromptProfiles(updates);
    const settings = await uiSettingsStore.get();
    return { profiles: profiles.map(toWire), activeProfileId: settings.activeServicePromptProfileId };
  };
}

function toWire(row: { id: string; name: string; isDefault: boolean; sortOrder: number; overrides: Record<string, string>; createdAt: string; updatedAt: string }): ServicePromptProfile {
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

async function buildResolvedMap(
  overrides: Record<string, string>,
): Promise<ServicePromptProfileDetailResponse["resolved"]> {
  const entries = await Promise.all(
    SERVICE_PROMPT_FIELD_KEYS.map(async (field) => {
      const raw = overrides[field];
      const override = typeof raw === "string" && raw.length > 0 ? raw : null;
      // Always resolve the live default — the UI's Default profile view renders it.
      const def = await resolveServicePromptDefaultPreview(field);
      return [field, { override, default: def }] as const;
    }),
  );
  // Loop-fill over the full FIELD_KEYS tuple provably covers every key at
  // runtime, but TS cannot express that for Object.fromEntries — same targeted
  // assertion as PROTOCOL_CAPABILITIES in protocol-registry.ts.
  return Object.fromEntries(entries) as ServicePromptProfileDetailResponse["resolved"];
}
