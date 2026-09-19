/**
 * Image-gen profiles hook (IMAGE_GENERATION_PLAN IG-10) — the editor state
 * machine for image-generation provider profiles, forked from the
 * use-stt-profiles shape (the plan's element-3 "profiles hook" pattern):
 * local-state CRUD lifecycle (reload / select / startCreate / startEdit /
 * setForm / save / remove / cancelEdit) + the view|edit headerMode machine,
 * with the image-gen additions the plan row names — probe / models /
 * samplers actions against the IG-8 routes.
 *
 * Deliberate deviations from the STT twin (each forced by an IG-10 boundary):
 * - `startCreate(defaultName, backend)` takes its seed values as PARAMETERS
 *   instead of reading i18n + a hardcoded zero-setup backend: the default
 *   profile name and the first preset's backend are IG-11 pane concerns (the
 *   pane owns the preset table and the i18n keys; IG-10 adds no keys).
 * - No auto-key hint machinery in v0 — SUPERSEDED by IG-21 (2026-09-17):
 *   the wire record now carries `autoKeyProviderName` and the hook exposes
 *   `draftAutoKeyProviderName` (server-decorated name wins; drafts fall to
 *   the client mirror — imagegen-form-helpers.ts, the STT twin).
 * - Capability flags ride the form: the create contract requires the
 *   capability mirror, so `startCreate`/backend-switch snapshot it from the
 *   static `IMAGE_GEN_BACKEND_CAPABILITIES` table (imported from the domain
 *   leaf — web-safe; NEVER from the @vibe-tavern/api barrel, which drags
 *   bun:sqlite into the browser bundle),
 *   `select` hydrates it from the saved record, and `save` sends it verbatim.
 * - The API key is the STT tri-state on the wire: blank form field = keep
 *   the stored key on update (`undefined` sent); a visible clear affordance
 *   is the pane's (IG-11) concern, mirroring how the STT editor treats it.
 */

import { useCallback, useEffect, useState } from "react";
import { IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_BACKENDS, type ImageGenBackendType } from "@vibe-tavern/domain";
import { matchImageGenAutoKeyProviderName, type ImageGenAutoKeyProviderCandidate } from "../components/settings/provider/imagegen/imagegen-form-helpers.js";
import { listProviderProfiles } from "../api/provider-api.js";
import type { LocalConnectionStatus } from "../components/shared/LocalConnectionStatus.js";
import type {
  CreateImageGenProfileInput,
  ImageGenCapabilityFlagsValue,
  ImageGenDefaultParamsValue,
  ImageGenModeSizePresetsValue,
  ImageGenModelFavoriteValue,
  ImageGenModelInfoValue,
  ImageGenModelSettingsOverlayValue,
  ImageGenProfileValue,
  ImageGenSamplerInfoValue,
  ImageGenSchedulerInfoValue,
  ImageGenUserSizeEntryValue,
  UpdateImageGenProfileInput,
} from "@vibe-tavern/api-contracts";
import {
  addImageGenModelFavorite,
  createImageGenProfile,
  deleteImageGenModelSettings,
  deleteImageGenProfile,
  draftListImageGenModels,
  getImageGenModelSettings,
  listAllImageGenProfiles,
  listImageGenModels,
  listImageGenModelFavorites,
  listImageGenSamplers,
  listImageGenSchedulers,
  listImageGenDitSidecars,
  removeImageGenModelFavorite,
  updateImageGenProfile,
  upsertImageGenModelSettings,
  type CreateImageGenProfileBody,
  type ImageGenDitSidecars,
  type ImageGenModelEntry,
  type ImageGenProfileRecord,
} from "../api/image-gen-api.js";

/** Editor form — the wire record's editable fields plus the write-only key
 *  field (see the module header for the tri-state rule). */
export interface ImageGenProfileForm {
  id: string | null;
  name: string;
  backend: ImageGenBackendType;
  /** UI preset slug; null = Custom (no preset). */
  presetId: string | null;
  endpoint: string;
  /** Typed write-only API key: empty while editing a stored-key profile =
   *  keep the stored one on save (undefined on the wire). */
  apiKey: string;
  /** Mirror of the record's write-only flag — drives the key field's
   *  "saved" placeholder. */
  hasStoredApiKey: boolean;
  /** Server-decorated auto-key hint (IG-21): the provider profile name
   *  whose key the execution seam would take; null while an own key wins.
   *  SAVED profiles only — drafts resolve through the client mirror
   *  (draftAutoKeyProviderName below). */
  autoKeyProviderName: string | null;
  modelId: string | null;
  defaultParams: ImageGenDefaultParamsValue;
  modeSizePresets: ImageGenModeSizePresetsValue;
  /** User-added vendor-size entries (IG-20a) — extend the vendor-set grid. */
  userSizes: ImageGenUserSizeEntryValue[];
  llmAssistEnabled: boolean;
  llmProviderProfileId: string | null;
  llmModelId: string | null;
  /** Capability mirror for the current backend — gates the pane's
   *  capability-gated controls without a live round-trip. */
  capabilities: ImageGenCapabilityFlagsValue;
}

/** Editor screen state, the STT/TTS headerMode twin: "view" = saved profile
 *  shown compact with fields below; "edit" = the connection form alone. */
export type ImageGenHeaderMode = "view" | "edit";

/** Wire-boundary normalizer: defensive against unknown backend slugs —
 *  degrades to the OpenRouter roster default (the toSttBackend rule without
 *  a blind cast). */
export function toImageGenBackend(raw: string): ImageGenBackendType {
  for (const slug of Object.values(IMAGE_GEN_BACKENDS)) {
    if (slug === raw) return slug;
  }
  return IMAGE_GEN_BACKENDS.OpenRouter;
}

/** Defensive copy of the static capability row for a backend — the form
 *  must never hold a reference into the shared registry table (a later
 *  in-place mutation would corrupt the single source of truth). */
function capabilitySnapshot(backend: ImageGenBackendType): ImageGenCapabilityFlagsValue {
  const caps = IMAGE_GEN_BACKEND_CAPABILITIES[backend];
  return {
    ...caps,
    sizeSupport:
      caps.sizeSupport.kind === "vendor-set"
        ? { kind: "vendor-set", sizes: [...caps.sizeSupport.sizes] }
        : { ...caps.sizeSupport },
  };
}

export function useImageProfiles(): {
  profiles: ImageGenProfileRecord[];
  loading: boolean;
  editingId: string | null;
  form: ImageGenProfileForm | null;
  dirty: boolean;
  error: string | null;
  saving: boolean;
  headerMode: ImageGenHeaderMode;
  /** Auto-key hint for the LIVE form (IG-21, the STT twin): the provider
   *  profile name whose key the server execution seam would take — the
   *  server-decorated name for saved profiles, the client mirror for
   *  drafts; null when nothing matches or an own key wins. */
  draftAutoKeyProviderName: string | null;
  /** Model catalog cache per saved profile (IG-11's "Fetch models, cached"). */
  modelsByProfile: Record<string, ImageGenModelEntry[]>;
  /** Sampler cache per saved profile (capability-gated consumers, IG-12). */
  samplersByProfile: Record<string, ImageGenSamplerInfoValue[]>;
  /** Scheduler (schedule type) cache per saved profile (PG-3, A1111 dialect
   *  only): options data for the advanced-panel dropdown — deliberately NOT
   *  wired into `samplerStatusByProfile` (a scheduler fetch failure is empty
   *  options, not a connectivity conclusion — the samplers fetch already
   *  owns that signal). */
  schedulersByProfile: Record<string, ImageGenSchedulerInfoValue[]>;
  /** DiT sidecar (text encoder + VAE) cache per saved profile (CG-B1,
   *  comfyui dialect only): options data for the advanced accordion's DiT
   *  fields — the `schedulersByProfile` rule verbatim (a sidecar fetch
   *  failure is empty options, never a connectivity conclusion). */
  sidecarsByProfile: Record<string, ImageGenDitSidecars>;
  /** Local-server connectivity per saved profile, driven by sampler fetches
   *  (IG-CF12a): `checking` while in flight, `online` on success, `offline`
   *  on ANY fetch failure — connectivity is deliberately NOT routed through
   *  the shared `error` (an A1111-down used to paint «profiles failed to
   *  load» while the profiles had loaded fine). Unknown-profile misses keep
   *  going to `error`. */
  samplerStatusByProfile: Record<string, LocalConnectionStatus>;
  /** Open the connection form screen (Edit settings). */
  startEdit(): void;
  /** Start a new profile. The seed values come from the caller (the pane
   *  owns the i18n default name and the preset table's backend). */
  startCreate(defaultName: string, backend: ImageGenBackendType): void;
  select(id: string): void;
  setForm(patch: Partial<ImageGenProfileForm>): void;
  save(): Promise<void>;
  remove(): Promise<void>;
  cancelEdit(): void;
  reload(): Promise<void>;
  /** Fetch + cache the model catalog for a saved profile (defaults to the
   *  editing one). Null = unknown profile; upstream failures throw and are
   *  recorded in `error`. */
  fetchSavedModels(id?: string): Promise<ImageGenModelEntry[] | null>;
  /** Fetch + cache samplers for a saved profile (defaults to the editing
   *  one) — call only for `capabilities.supportsSamplers` backends. Null =
   *  unknown profile (recorded in `error`); fetch failures land in the
   *  per-profile `samplerStatusByProfile` as `offline` (IG-CF12a), never
   *  in the shared `error`. */
  fetchSamplers(id?: string): Promise<ImageGenSamplerInfoValue[] | null>;
  /** Fetch + cache schedulers for a saved A1111-dialect profile (PG-3,
   *  defaults to the editing one). Null = unknown profile or unsupported
   *  backend; failures land ONLY in the cache as absent (never in the
   *  shared `error` — see `schedulersByProfile`). */
  fetchSchedulers(id?: string): Promise<ImageGenSchedulerInfoValue[] | null>;
  /** Fetch + cache DiT sidecar lists for a saved comfyui-dialect profile
   *  (CG-B1, defaults to the editing one). Null = unknown profile or
   *  unsupported backend; failures land ONLY in the cache as absent
   *  (never in the shared `error` — see `sidecarsByProfile`). */
  fetchSidecars(id?: string): Promise<ImageGenDitSidecars | null>;
  /** Shared fetch-by-endpoint model listing over the TRANSIENT form config
   *  (the STT draft twin): the just-typed endpoint/key ride inside the
   *  draft config; `profileId` lets the server inject the stored key when
   *  the form's own is empty and the endpoint matches. Returns the entries
   *  (transient — never cached); failures RETHROW to the caller (the
   *  form's Test badge is the only surface — MR-2: the shared `error` is
   *  never touched, so a failed draft can never paint «profiles failed to
   *  load» over the list). */
  fetchDraftModels(): Promise<ImageGenModelEntry[]>;
  /** Persisted star-bookmarks for the editing profile (IG-12b). */
  favorites: ImageGenModelFavoriteValue[];
  /** Star a model (immediate POST — bookmarks are not form-dirty state;
   *  re-starring refreshes the label). */
  starModel(modelId: string, label?: string): Promise<void>;
  /** Un-star (immediate DELETE; the model's overlay row survives —
   *  favorites are bookmarks, overlays are config). */
  unstarModel(modelId: string): Promise<void>;
  /** The editing profile's CURRENT per-model overlay state (IG-12b, the
   *  bindPerModel mechanic on data instead of a profile column): non-null
   *  while per-model binding is ON for the selected model — edits ride the
   *  form-dirty Save; null = the fields below route to the profile base. */
  modelOverlay: ImageGenModelSettingsOverlayValue | null;
  /** True when `modelOverlay` has unsaved edits (folded into `dirty`). */
  overlayDirty: boolean;
  /** Load the selected model's overlay from the server (non-dirtying —
   *  used on select / model switch / after save to sync the bind state:
   *  non-null GET result turns binding ON). */
  loadModelOverlay(): Promise<void>;
  /** Turn per-model binding ON for the selected model (opens the overlay
   *  editor at the stored overlay or empty — empty fields inherit the
   *  profile base). No-op without a selected model. */
  bindModelOverlay(): Promise<void>;
  /** Turn binding OFF: immediately DELETE the overlay (the model reverts
   *  to the profile base — the revert is the destructive action, mirroring
   *  how the LLM toggle off routes writes back to the base). */
  unbindModelOverlay(): Promise<void>;
  /** Edit the open overlay (form-dirty). */
  setModelOverlay(patch: Partial<ImageGenModelSettingsOverlayValue>): void;
  /** The applied sampler set's id on the open overlay (IG-CF15 — provenance
   *  for the pane's set row; copy-on-select, never a live link). */
  modelOverlaySetId: string | null;
  /** Bind the open overlay to a set (apply) or clear the pointer
   *  (No set — values stay); an apply with `values` also copies the
   *  set's payload into the overlay. Form-dirty like any overlay edit. */
  setModelSamplerSetBinding(setId: string | null, values?: Partial<ImageGenModelSettingsOverlayValue>): void;
} {
  const [profiles, setProfiles] = useState<ImageGenProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setFormState] = useState<ImageGenProfileForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [headerMode, setHeaderMode] = useState<ImageGenHeaderMode>("view");
  const [modelsByProfile, setModelsByProfile] = useState<Record<string, ImageGenModelEntry[]>>({});
  const [samplersByProfile, setSamplersByProfile] = useState<Record<string, ImageGenSamplerInfoValue[]>>({});
  const [schedulersByProfile, setSchedulersByProfile] = useState<Record<string, ImageGenSchedulerInfoValue[]>>({});
  const [sidecarsByProfile, setSidecarsByProfile] = useState<Record<string, ImageGenDitSidecars>>({});
  const [samplerStatusByProfile, setSamplerStatusByProfile] = useState<Record<string, LocalConnectionStatus>>({});
  const [favorites, setFavorites] = useState<ImageGenModelFavoriteValue[]>([]);
  const [modelOverlay, setModelOverlayState] = useState<ImageGenModelSettingsOverlayValue | null>(null);
  const [overlayDirty, setOverlayDirty] = useState(false);
  const [modelOverlaySetId, setModelOverlaySetIdState] = useState<string | null>(null);
  // IG-21 auto-key mirror inputs: the keyful-provider list for the hint
  //  rule (the use-stt-profiles twin — loaded once, hint-only projection,
  //  no key material ever crosses the wire).
  const [autoKeyProviders, setAutoKeyProviders] = useState<ImageGenAutoKeyProviderCandidate[]>([]);

  // IG-21 auto-key mirror inputs load (the use-stt-profiles twin): the
  //  keyful-provider list for the hint rule — loaded once, hint-only
  //  projection, no key material ever crosses the wire.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const providers = await listProviderProfiles();
        if (cancelled) return;
        setAutoKeyProviders(providers.map((p) => ({ endpoint: p.endpoint, hasStoredApiKey: p.hasStoredApiKey, name: p.name })));
      } catch (cause) {
        console.debug("[image-gen] auto-key hint: provider list unavailable", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // IG-21: resolve the auto-key hint for the LIVE form. A server-decorated
  //  name (saved record) wins; drafts fall through to the client-side
  //  mirror of the server hint rule (matchImageGenAutoKeyProviderName).
  //  OpenRouter matches by vendor host; every other endpoint-driven cloud
  //  backend by exact endpoint (the MR-3 generalization); a1111/comfyui
  //  never match.
  const draftAutoKeyProviderName =
    form?.autoKeyProviderName !== null && form?.autoKeyProviderName !== undefined
      ? form.autoKeyProviderName
      : form === null
        ? null
        : matchImageGenAutoKeyProviderName(form.backend, form.endpoint, autoKeyProviders);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllImageGenProfiles();
      setProfiles(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function hydrate(record: ImageGenProfileValue): ImageGenProfileForm {
    return {
      id: record.id,
      name: record.name,
      backend: toImageGenBackend(record.backend),
      presetId: record.presetId ?? null,
      endpoint: record.endpoint,
      // record never carries the apiKey (typed column) — the key field
      // starts empty and shows the "saved" placeholder instead.
      apiKey: "",
      hasStoredApiKey: record.hasStoredApiKey,
      autoKeyProviderName: record.autoKeyProviderName ?? null,
      modelId: record.modelId ?? null,
      defaultParams: { ...record.defaultParams },
      modeSizePresets: { ...record.modeSizePresets },
      userSizes: record.userSizes !== undefined ? record.userSizes.map((entry) => ({ ...entry })) : [],
      llmAssistEnabled: record.llmAssistEnabled,
      llmProviderProfileId: record.llmProviderProfileId ?? null,
      llmModelId: record.llmModelId ?? null,
      capabilities: { ...record.capabilities },
    };
  }

  const loadFavorites = useCallback(async (profileId: string) => {
    setError(null);
    try {
      setFavorites(await listImageGenModelFavorites(profileId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadModelOverlay = useCallback(async () => {
    if (form?.id === null || form?.id === undefined || form.modelId === null) {
      setModelOverlayState(null);
      setOverlayDirty(false);
      return;
    }
    setError(null);
    try {
      const row = await getImageGenModelSettings(form.id, form.modelId);
      setModelOverlayState(row === null ? null : { ...row.settings });
      setModelOverlaySetIdState(row?.samplerSetId ?? null);
      setOverlayDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [form]);

  const starModel = useCallback(
    async (modelId: string, label?: string) => {
      if (!form?.id) return;
      setError(null);
      try {
        await addImageGenModelFavorite(form.id, { modelId, ...(label !== undefined ? { label } : {}) });
        await loadFavorites(form.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [form, loadFavorites],
  );

  const unstarModel = useCallback(
    async (modelId: string) => {
      if (!form?.id) return;
      setError(null);
      try {
        await removeImageGenModelFavorite(form.id, modelId);
        await loadFavorites(form.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [form, loadFavorites],
  );

  const bindModelOverlay = useCallback(async () => {
    if (form?.id === null || form?.id === undefined || form.modelId === null) return;
    setError(null);
    try {
      const row = await getImageGenModelSettings(form.id, form.modelId);
      setModelOverlayState(row === null ? {} : { ...row.settings });
      setModelOverlaySetIdState(row?.samplerSetId ?? null);
      setOverlayDirty(row !== null);
      // Binding ON with a stored overlay is already the persisted state —
      // dirty only when the editor must PUT something new (an empty bind on
      // a model with no overlay stays non-dirty until a field is touched).
      if (row === null) setOverlayDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [form]);

  const unbindModelOverlay = useCallback(async () => {
    if (form?.id === null || form?.id === undefined || form.modelId === null) {
      setModelOverlayState(null);
      setModelOverlaySetIdState(null);
      setOverlayDirty(false);
      return;
    }
    setError(null);
    try {
      await deleteImageGenModelSettings(form.id, form.modelId);
      setModelOverlayState(null);
      setModelOverlaySetIdState(null);
      setOverlayDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [form]);

  const setModelOverlay = useCallback((patch: Partial<ImageGenModelSettingsOverlayValue>) => {
    setModelOverlayState((prev) => (prev === null ? prev : { ...prev, ...patch }));
    setOverlayDirty(true);
    setDirty(true);
  }, []);

  const setModelSamplerSetBinding = useCallback(
    (setId: string | null, values?: Partial<ImageGenModelSettingsOverlayValue>) => {
      // Apply (setId + values): copy the set's payload into the overlay AND
      // record the pointer. "No set" (setId null, no values): clear the
      // pointer only — the overlay's current values stay (the LLM
      // handleSelectSet rule).
      if (values !== undefined) {
        setModelOverlayState((prev) => (prev === null ? prev : { ...prev, ...values }));
      }
      setModelOverlaySetIdState(setId);
      setOverlayDirty(true);
      setDirty(true);
    },
    [],
  );

  const select = useCallback(
    (id: string) => {
      const record = profiles.find((p) => p.id === id);
      if (!record) return;
      setEditingId(id);
      setFormState(hydrate(record));
      setDirty(false);
      setHeaderMode("view");
      setError(null);
      // Second-level state follows the selection (IG-12): stars + the
      // selected model's bind state reload per profile. The overlay load is
      // the SAME fire-and-forget GET as the setForm model-switch branch
      // below — select() hydrates directly (no setForm), so without this the
      // bind toggle would render OFF for a model with a STORED overlay until
      // the user toggled it (the "reload — persisted" plan rule).
      void loadFavorites(id);
      setModelOverlayState(null);
      setModelOverlaySetIdState(null);
      setOverlayDirty(false);
      if (record.modelId != null) {
        const nextModelId = record.modelId;
        void (async () => {
          try {
            const row = await getImageGenModelSettings(id, nextModelId);
            setModelOverlayState(row === null ? null : { ...row.settings });
            setModelOverlaySetIdState(row?.samplerSetId ?? null);
          } catch {
            // Non-fatal: the pane's bind toggle re-fetches on demand.
          }
        })();
      }
    },
    [profiles, loadFavorites],
  );

  const startCreate = useCallback((defaultName: string, backend: ImageGenBackendType) => {
    setEditingId(null);
    setFormState({
      id: null,
      name: defaultName,
      backend,
      presetId: null,
      endpoint: "",
      apiKey: "",
      hasStoredApiKey: false,
      autoKeyProviderName: null,
      modelId: null,
      defaultParams: {},
      modeSizePresets: {},
      userSizes: [],
      llmAssistEnabled: false,
      llmProviderProfileId: null,
      llmModelId: null,
      capabilities: capabilitySnapshot(backend),
    });
    setDirty(false);
    setHeaderMode("edit");
    setError(null);
  }, []);

  const startEdit = useCallback(() => setHeaderMode("edit"), []);

  const setForm = useCallback((patch: Partial<ImageGenProfileForm>) => {
    setFormState((prev) => {
      if (!prev) return prev;
      if (patch.backend !== undefined && patch.backend !== prev.backend) {
        const nextBackend = patch.backend;
        // Backend switch resets everything backend-coupled — stale fields
        // must never leak across backends (the STT rule): a stored key, a
        // picked model, a preset slug (a preset implies a backend), the
        // per-backend param defaults and size presets, and the endpoint
        // (no invented default URLs — the hardcoded-parameters ban). The
        // LLM-assist wiring is profile-level and survives the switch.
        return {
          ...prev,
          ...patch,
          backend: nextBackend,
          presetId: null,
          endpoint: "",
          apiKey: "",
          hasStoredApiKey: false,
          autoKeyProviderName: null,
          modelId: null,
          defaultParams: {},
          modeSizePresets: {},
          userSizes: [],
          capabilities: capabilitySnapshot(nextBackend),
        };
      }
      if (patch.modelId !== undefined && patch.modelId !== prev.modelId) {
        // Model switch (IG-12): the bind state follows the SELECTION — drop
        // the open overlay (unsaved edits discard, the cancelEdit family
        // rule) and load the new model's stored overlay fire-and-forget.
        setModelOverlayState(null);
        setModelOverlaySetIdState(null);
        setOverlayDirty(false);
        if (prev.id !== null && patch.modelId !== null) {
          const profileId = prev.id;
          const nextModelId = patch.modelId;
          void (async () => {
            try {
              const row = await getImageGenModelSettings(profileId, nextModelId);
              setModelOverlayState(row === null ? null : { ...row.settings });
              setModelOverlaySetIdState(row?.samplerSetId ?? null);
            } catch {
              // Non-fatal: the pane's bind toggle re-fetches on demand.
            }
          })();
        }
      }
      return { ...prev, ...patch };
    });
    setDirty(true);
  }, []);

  const cancelEdit = useCallback(() => {
    if (editingId) {
      const record = profiles.find((p) => p.id === editingId);
      if (record) setFormState(hydrate(record));
      setDirty(false);
      setHeaderMode("view");
      setError(null);
      return;
    }
    setFormState(null);
    setDirty(false);
    setHeaderMode("view");
    setError(null);
  }, [editingId, profiles]);

  const save = useCallback(async () => {
    if (!form) return;
    const trimmedName = form.name.trim();
    const trimmedEndpoint = form.endpoint.trim();
    // Sibling parity: invalid form = silent no-op (the pane owns the
    // validation copy; the wire schema would 422 with a raw zod message).
    if (trimmedName.length === 0 || trimmedEndpoint.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      // STT tri-state: blank form key sends undefined — create treats it as
      // absent, update as "keep the stored key".
      const apiKeyPayload = form.apiKey.trim() === "" ? undefined : form.apiKey.trim();
      let saved: ImageGenProfileRecord;
      if (form.id === null) {
        saved = await createImageGenProfile({
          name: trimmedName,
          backend: form.backend,
          presetId: form.presetId ?? undefined,
          endpoint: trimmedEndpoint,
          apiKey: apiKeyPayload,
          modelId: form.modelId ?? undefined,
          defaultParams: form.defaultParams,
          modeSizePresets: form.modeSizePresets,
          ...(form.userSizes.length > 0 ? { userSizes: form.userSizes } : {}),
          llmAssistEnabled: form.llmAssistEnabled,
          llmProviderProfileId: form.llmProviderProfileId ?? undefined,
          llmModelId: form.llmModelId ?? undefined,
          capabilities: form.capabilities,
        } satisfies CreateImageGenProfileBody);
      } else {
        saved = await updateImageGenProfile(form.id, {
          name: trimmedName,
          backend: form.backend,
          presetId: form.presetId,
          endpoint: trimmedEndpoint,
          apiKey: apiKeyPayload,
          modelId: form.modelId,
          defaultParams: form.defaultParams,
          modeSizePresets: form.modeSizePresets,
          userSizes: form.userSizes,
          llmAssistEnabled: form.llmAssistEnabled,
          llmProviderProfileId: form.llmProviderProfileId,
          llmModelId: form.llmModelId,
          capabilities: form.capabilities,
        } satisfies UpdateImageGenProfileInput);
      }
      const list = await listAllImageGenProfiles();
      setProfiles(list);
      setEditingId(saved.id);
      setFormState(hydrate(saved));
      setDirty(false);
      setHeaderMode("view");
      // Per-model overlay routing (IG-12b, the bindPerModel mechanic on
      // data): a bound + edited overlay PUTs AFTER the profile PATCH — the
      // overlay is the LLM twin's "route the save to the model" arm. An
      // overlay PUT failure surfaces into `error` with the profile already
      // saved (two writes, one Save button — the master-detail contract).
      if (modelOverlay !== null && overlayDirty && form.modelId !== null) {
        try {
          await upsertImageGenModelSettings(saved.id, form.modelId, modelOverlay, modelOverlaySetId);
          setOverlayDirty(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } else {
        setOverlayDirty(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [form, modelOverlay, overlayDirty, modelOverlaySetId]);

  const remove = useCallback(async () => {
    if (!form?.id) {
      setFormState(null);
      setEditingId(null);
      setDirty(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteImageGenProfile(form.id);
      const list = await listAllImageGenProfiles();
      setProfiles(list);
      setFormState(null);
      setEditingId(null);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [form]);

  const fetchSavedModels = useCallback(
    async (id?: string): Promise<ImageGenModelEntry[] | null> => {
      const targetId = id ?? form?.id;
      if (!targetId) return null;
      setError(null);
      try {
        const models = await listImageGenModels(targetId);
        if (models === null) {
          setError("Image-gen profile not found");
          return null;
        }
        setModelsByProfile((prev) => ({ ...prev, [targetId]: models }));
        return models;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [form],
  );

  const fetchSamplers = useCallback(
    async (id?: string): Promise<ImageGenSamplerInfoValue[] | null> => {
      const targetId = id ?? form?.id;
      if (!targetId) return null;
      // IG-CF12a: connectivity is a per-profile status, not the shared
      // `error` — an A1111-down sampler fetch used to paint «profiles
      // failed to load» over a perfectly loaded list. checking → online on
      // success; ANY fetch failure → offline (the route's 400 drift and a
      // dead server are indistinguishable client-side, and both mean "the
      // sampler surface is unusable right now"). Unknown-profile nulls stay
      // in `error` and reset the status to `unknown` (no conclusion drawn).
      setSamplerStatusByProfile((prev) => ({ ...prev, [targetId]: "checking" }));
      try {
        const samplers = await listImageGenSamplers(targetId);
        if (samplers === null) {
          setSamplerStatusByProfile((prev) => ({ ...prev, [targetId]: "unknown" }));
          setError("Image-gen profile not found");
          return null;
        }
        setSamplerStatusByProfile((prev) => ({ ...prev, [targetId]: "online" }));
        setSamplersByProfile((prev) => ({ ...prev, [targetId]: samplers }));
        return samplers;
      } catch {
        setSamplerStatusByProfile((prev) => ({ ...prev, [targetId]: "offline" }));
        return null;
      }
    },
    [form],
  );

  const fetchSchedulers = useCallback(
    async (id?: string): Promise<ImageGenSchedulerInfoValue[] | null> => {
      const targetId = id ?? form?.id;
      if (!targetId) return null;
      // PG-3: options data only — a failure leaves the cache untouched
      // (empty options) and draws NO connectivity conclusion; the samplers
      // fetch owns `samplerStatusByProfile`.
      try {
        const schedulers = await listImageGenSchedulers(targetId);
        if (schedulers === null) return null;
        setSchedulersByProfile((prev) => ({ ...prev, [targetId]: schedulers }));
        return schedulers;
      } catch {
        return null;
      }
    },
    [form],
  );

  const fetchSidecars = useCallback(
    async (id?: string): Promise<ImageGenDitSidecars | null> => {
      const targetId = id ?? form?.id;
      if (!targetId) return null;
      // CG-B1: options data only — the fetchSchedulers rule verbatim (a
      // failure leaves the cache untouched and draws NO connectivity
      // conclusion; the samplers fetch owns `samplerStatusByProfile`).
      try {
        const sidecars = await listImageGenDitSidecars(targetId);
        if (sidecars === null) return null;
        setSidecarsByProfile((prev) => ({ ...prev, [targetId]: sidecars }));
        return sidecars;
      } catch {
        return null;
      }
    },
    [form],
  );

  const fetchDraftModels = useCallback(async (): Promise<ImageGenModelEntry[]> => {
    if (!form) throw new Error("no image-gen form");
    // MR-2 (the IG-CF12a doctrine, draft arm): the shared `error` is never
    //  touched — neither cleared nor set. A failed Test connection is the
    //  FORM's badge only (handleTest catches); the section banner stays
    //  reserved for real profile-list load failures.
    return await draftListImageGenModels({
      backend: form.backend,
      // The just-typed key rides inside the draft config (the STT draft
      // rule — a strict shape would strip the secret before the factory
      // sees it); profileId enables stored-key resolution when the form's
      // own key is empty and the endpoint matches.
      config: {
        endpoint: form.endpoint.trim(),
        ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
      },
      profileId: form.id ?? undefined,
    });
  }, [form]);

  return {
    profiles,
    loading,
    editingId,
    form,
    dirty,
    error,
    saving,
    headerMode,
    draftAutoKeyProviderName,
    modelsByProfile,
    samplersByProfile,
    schedulersByProfile,
    sidecarsByProfile,
    samplerStatusByProfile,
    favorites,
    modelOverlay,
    overlayDirty,
    startEdit,
    startCreate,
    select,
    setForm,
    save,
    remove,
    cancelEdit,
    reload,
    fetchSavedModels,
    fetchSamplers,
    fetchSchedulers,
    fetchSidecars,
    fetchDraftModels,
    starModel,
    unstarModel,
    loadModelOverlay,
    bindModelOverlay,
    unbindModelOverlay,
    setModelOverlay,
    modelOverlaySetId,
    setModelSamplerSetBinding,
  };
}
