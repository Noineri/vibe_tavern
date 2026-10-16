import { useEffect } from "react";
import type { ImageGenProfilesApi } from "../../../../hooks/image-gen-profiles-api.js";

/**
 * One-shot listing cache fills for the open profile in `ImageGenPane` —
 * moved out of the pane (file-size ratchet) when the model catalog fill
 * joined them (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11). Each effect
 * fills its cache once per profile; «refresh» buttons in the pane are the
 * live re-fetch paths. Gates are guard-style values computed by the pane
 * ABOVE its null guard (hook-order invariant), so `profileId` is null while
 * no saved form is open.
 */
export function useImageGenListingFills(
  imageGen: ImageGenProfilesApi,
  profileId: string | null,
  gates: { supportsSamplers: boolean; isLocalDialect: boolean; isDit: boolean },
): void {
  const { supportsSamplers, isLocalDialect, isDit } = gates;

  // Model catalog (step 11, owner 2026-10-15: pick the model once, never
  // re-request the list just to open the profile — the LLM provider picker
  // pattern): the STORED list fills the picker with no upstream call; the
  // server lists live only when nothing is stored yet. Options data only (a
  // failure leaves the cache empty, no shared error); the picker's refresh
  // button is the live path that overwrites the stored list. `modelsCached`
  // re-arms the fill when the hook drops the cache (a saved endpoint or
  // backend change); a failed read leaves it false, so it never loops.
  const modelsCached = profileId !== null && imageGen.modelsByProfile[profileId] !== undefined;
  useEffect(() => {
    if (profileId === null || modelsCached) return;
    void imageGen.fetchSavedModels(profileId, { storedFirst: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [profileId, modelsCached]);

  useEffect(() => {
    if (profileId === null || !supportsSamplers) return;
    if ((imageGen.samplersByProfile[profileId] ?? []).length === 0) {
      void imageGen.fetchSamplers(profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [profileId, supportsSamplers]);

  // Scheduler list (PG-3) — the dialect-gated schedule-type catalog, one-shot
  // cache fill per profile (the samplers-guard twin, dialect-gated: the
  // schedulers route exists only on the local family). Failure = empty
  // options, no connectivity signal (the samplers fetch owns that).
  useEffect(() => {
    if (profileId === null || !isLocalDialect) return;
    if ((imageGen.schedulersByProfile[profileId] ?? []).length === 0) {
      void imageGen.fetchSchedulers(profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [profileId, isLocalDialect]);

  // DiT sidecar lists (CG-B1, comfyui dialect): filled when the selected
  // model (or the manual base-workflow pick) resolves a DiT workflow family
  // — the gate is the pane's `buildDitSidecarControls` projection.
  useEffect(() => {
    if (profileId === null || !isDit) return;
    if (imageGen.sidecarsByProfile[profileId] === undefined) {
      void imageGen.fetchSidecars(profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [profileId, isDit]);

  // VAE list (IF-7b): the swappable-VAE vocabulary for the advanced
  // accordion's VAE field — one-shot cache fill per LOCAL profile (A1111
  // + ComfyUI; the field renders for every non-DiT local target).
  // Options-data only (the fetchSidecars rule verbatim).
  useEffect(() => {
    if (profileId === null || !isLocalDialect) return;
    if (imageGen.vaeByProfile[profileId] === undefined) {
      void imageGen.fetchVae(profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [profileId, isLocalDialect]);
}
