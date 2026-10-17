/**
 * The Playground's provider/model option loading for model seats (IR-90E) —
 * the provider-profile list, the lazily fetched per-profile model lists and
 * the option builders the roster's pickers read. Moved verbatim out of
 * `ExperiencePlayground.tsx` (file-size ratchet): the roster (`seats`) stays
 * in the panel, which passes it in; nothing here touches a store.
 */
import { useEffect, useState } from "react";
import { EXPERIENCE_CONTROLLER } from "@vibe-tavern/domain";
import { fetchProviderProfileModels, listProviderProfiles } from "../../../api/provider-api.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import type { PlaygroundSeat } from "./experience-playground-model.js";

export function usePlaygroundModelOptions(seats: readonly PlaygroundSeat[]) {
  // IR-90E: provider/model loading for model seats (mirrors ExperienceSetupModal).
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[] | null>(null);
  const [modelsByProfile, setModelsByProfile] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [loadingProfiles, setLoadingProfiles] = useState<Set<string>>(new Set());

  // IR-90E: load provider profiles when the panel opens and a model seat exists.
  const hasModelSeat = seats.some((s) => s.controller === EXPERIENCE_CONTROLLER.model);
  useEffect(() => {
    if (!hasModelSeat || providerProfiles !== null) return;
    let cancelled = false;
    listProviderProfiles()
      .then((profiles) => { if (!cancelled) setProviderProfiles(profiles); })
      .catch(() => { if (!cancelled) setProviderProfiles([]); });
    return () => { cancelled = true; };
  }, [hasModelSeat, providerProfiles]);

  function ensureModels(profileId: string): void {
    if (profileId === "" || modelsByProfile[profileId] !== undefined || loadingProfiles.has(profileId)) return;
    setLoadingProfiles((prev) => new Set(prev).add(profileId));
    fetchProviderProfileModels(profileId)
      .then((res) => { setModelsByProfile((prev) => ({ ...prev, [profileId]: res.models.map((m) => ({ id: m.id, label: m.label || m.id })) })); })
      .catch(() => { setModelsByProfile((prev) => ({ ...prev, [profileId]: [] })); })
      .finally(() => { setLoadingProfiles((prev) => { const n = new Set(prev); n.delete(profileId); return n; }); });
  }

  function modelOptionsFor(profileId: string): Array<{ id: string; label: string }> {
    const fetched = modelsByProfile[profileId] ?? [];
    const options = fetched.map((m) => ({ id: m.id, label: m.label }));
    const profile = (providerProfiles ?? []).find((p) => p.id === profileId);
    if (profile?.defaultModel && !options.some((o) => o.id === profile.defaultModel)) {
      options.push({ id: profile.defaultModel, label: profile.defaultModel });
    }
    return options;
  }

  const providerOptions = (providerProfiles ?? []).map((p) => ({ id: p.id, label: p.name || p.id }));

  return { providerOptions, loadingProfiles, ensureModels, modelOptionsFor };
}
