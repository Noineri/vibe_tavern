/**
 * The public contract of `useImageProfiles` (use-image-profiles.ts). Moved
 * out of the hook's inline return-type annotation (file-size ratchet) when
 * IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11 changed `fetchSavedModels`.
 * Consumers keep reading it as `ReturnType<typeof useImageProfiles>`.
 */
import type { ImageGenBackendType } from "@vibe-tavern/domain";
import type {
  ImageGenDefaultParamsValue,
  ImageGenModelFavoriteValue,
  ImageGenModelSettingsOverlayValue,
  ImageGenSamplerInfoValue,
  ImageGenSchedulerInfoValue,
} from "@vibe-tavern/api-contracts";
import type { ImageGenDitSidecars, ImageGenModelEntry, ImageGenProfileRecord } from "../api/image-gen-api.js";
import type { LocalConnectionStatus } from "../components/shared/LocalConnectionStatus.js";
import type { ImageGenProfileForm } from "./image-gen-profile-form.js";

/** Editor screen state, the STT/TTS headerMode twin: "view" = saved profile
 *  shown compact with fields below; "edit" = the connection form alone. */
export type ImageGenHeaderMode = "view" | "edit";

export interface ImageGenProfilesApi {
  profiles: ImageGenProfileRecord[];
  /** Master-list filter state; matches profile name and the visible preset label. */
  profileSearch?: string;
  filteredProfiles?: ImageGenProfileRecord[];
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
  /** Sidecar-fetch failure per saved profile (T3 hint parity — the pane's
   *  `image_gen_sidecars_failed` twin of the chip's hint): `true` after a
   *  failed fetch, cleared by a later success. The `sidecarsByProfile`
   *  rule verbatim — never a connectivity conclusion, never the shared
   *  `error`. */
  sidecarsFailedByProfile: Record<string, boolean>;
  /** IF-20: the ISO time of the server's last-good snapshot when the cached
   *  listing came from it (the live fetch failed); null/absent = live. One
   *  entry per saved profile and listing — the models catalog and the DiT
   *  sidecar folders. Renderers show it as an honest «saved list» hint. */
  modelsSnapshotAtByProfile: Record<string, string | null>;
  sidecarsSnapshotAtByProfile: Record<string, string | null>;
  vaeByProfile: Record<string, string[]>;
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
  setProfileSearch?(value: string): void;
  reorder?(updates: Array<{ id: string; sortOrder: number }>): Promise<void>;
  /** MR-12 (the STT `setDefault` twin): make `id` the GLOBAL active
   *  profile — persists server-side (the dedicated default route), so the
   *  pointer survives restarts/reloads; the session pointer flips only on
   *  success. Failures land in the shared `error`. */
  activateProfile(id: string): Promise<void>;
  /** Fetch + cache the model catalog for a saved profile (defaults to the
   *  editing one). Default = the refresh path: live (the IF-20 snapshot when
   *  the live call fails); a failure resolves null and lands in `error`.
   *  `storedFirst` = the open path (step 11, the LLM picker pattern): the
   *  stored list with no upstream call, live only when nothing is stored;
   *  options data only — a failure resolves null, leaves the cache
   *  untouched and sets no shared error (the fetchSidecars rule). Null also
   *  = unknown profile. */
  fetchSavedModels(id?: string, options?: { storedFirst?: boolean }): Promise<ImageGenModelEntry[] | null>;
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
  /** Fetch + cache the VAE list for a saved local profile (IF-7b, defaults
   *  to the editing one) — the swappable-VAE vocabulary for the advanced
   *  accordion's VAE field. Null = unknown profile or unsupported
   *  backend; failures land ONLY in the cache as absent (never in the
   *  shared `error` — the fetchSidecars rule verbatim). */
  fetchVae(id?: string): Promise<string[] | null>;
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
  /** IF-7a: the UNBOUND arm of the sets row — apply a set to the profile
   *  BASE (copy the payload into the form's defaultParams + point
   *  `defaultParamsSetId`), or clear the pointer only (`setId` null,
   *  no payload — values stay, the setModelSamplerSetBinding rule
   *  verbatim). Form-dirty; rides the profile PATCH on Save. */
  applyBaseSamplerSet(setId: string | null, payload?: Partial<ImageGenDefaultParamsValue>): void;
}
