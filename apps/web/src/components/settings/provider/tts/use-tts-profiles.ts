import { useCallback, useEffect, useState } from "react";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { TTS_PRESET_CONFIG_KEY } from "./tts-backend-ui.js";
import {
  createTtsProfile,
  deleteTtsProfile,
  listAllTtsProfiles,
  setTtsDefault,
  updateTtsProfile,
  type TtsProfileRecord,
} from "../../../../api/tts-api.js";

export interface TtsProfileForm {
  id: string | null;
  name: string;
  backend: TtsBackendSlug;
  config: Record<string, unknown>;
  /** Typed write-only API key (TE2-16): lives in the form while editing,
   *  rides the top-level save field — NEVER inside `config`. Empty while
   *  editing a stored-key profile = keep the stored one on save (the
   *  server's tri-state: undefined=keep, ""=clear, non-empty=set). */
  apiKey: string;
  /** Stored providerProfiles.id link (TE2-16) — round-tripped for display;
   *  the form does not edit it (no picker yet), so save sends it as
   *  undefined (= keep). */
  providerRef: string | null;
  voiceId: string;
  narratorVoiceId: string;
  /** Mirror of the record's write-only flag (TE2-16): true while editing a
   *  profile whose typed api_key column holds a key. Drives the key field's
   *  "saved" placeholder; an empty typed key + this flag = keep the stored
   *  one on save (tri-state update). */
  hasStoredApiKey: boolean;
}

/** Wire-boundary normalizer: the server already degrades unknown backend
 *  slugs to kokoro on read, but the client stays defensive — mirrors that
 *  forward-compat rule without a blind cast. */
export function toBackendSlug(raw: string): TtsBackendSlug {
  for (const slug of Object.values(TTS_BACKEND)) {
    if (slug === raw) return slug;
  }
  return TTS_BACKEND.Kokoro;
}

/** Editor screen state, mirroring the LLM modal's headerMode: "view" = saved
 *  profile shown as the compact TtsBaseCard with config sections below;
 *  "edit" = the connection form alone (a separate screen — config sections
 *  hidden), entered via Edit settings / New, exited by Save / Cancel / select. */
export type TtsHeaderMode = "view" | "edit";

export function useTtsProfiles(): {
  profiles: TtsProfileRecord[];
  loading: boolean;
  editingId: string | null;
  form: TtsProfileForm | null;
  dirty: boolean;
  error: string | null;
  saving: boolean;
  /** Current editor screen (LLM headerMode analog). */
  headerMode: TtsHeaderMode;
  /** Open the connection form screen (Edit settings / New profile). */
  startEdit(): void;
  /** Mark a saved profile as the default voice (first UI surface for
   *  isDefault — the API already existed, see Current state). */
  setDefault(id: string): Promise<void>;
  select(id: string): void;
  startCreate(): void;
  setForm(patch: Partial<TtsProfileForm>): void;
  save(): Promise<void>;
  remove(): Promise<void>;
  cancelEdit(): void;
  reload(): Promise<void>;
} {
  const [profiles, setProfiles] = useState<TtsProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setFormState] = useState<TtsProfileForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [headerMode, setHeaderMode] = useState<TtsHeaderMode>("view");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllTtsProfiles();
      setProfiles(list);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    (id: string) => {
      const record = profiles.find((p) => p.id === id);
      if (!record) return;
      setEditingId(id);
      setFormState({
        id: record.id,
        name: record.name,
        backend: toBackendSlug(record.backend),
        // record.config never carries the apiKey (TE2-16 typed column) — the
        // key field starts empty and shows the "saved" placeholder instead.
        config: { ...record.config },
        apiKey: "",
        providerRef: record.providerRef ?? null,
        voiceId: record.voiceId ?? "",
        narratorVoiceId: record.narratorVoiceId ?? "",
        hasStoredApiKey: record.hasStoredApiKey,
      });
      setDirty(false);
      setHeaderMode("view");
      setError(null);
    },
    [profiles],
  );

  const startCreate = useCallback(() => {
    setEditingId(null);
    setFormState({ id: null, name: "", backend: TTS_BACKEND.Kokoro, config: {}, apiKey: "", providerRef: null, voiceId: "af_heart", narratorVoiceId: "", hasStoredApiKey: false });
    setDirty(false);
    setHeaderMode("edit");
    setError(null);
  }, []);

  const startEdit = useCallback(() => setHeaderMode("edit"), []);

  const setDefault = useCallback(async (id: string) => {
    setError(null);
    try {
      await setTtsDefault(id);
      const list = await listAllTtsProfiles();
      setProfiles(list);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    }
  }, []);

  const setForm = useCallback((patch: Partial<TtsProfileForm>) => {
    setFormState((prev) => {
      if (!prev) return prev;
      // Backend switch resets config and voiceId — stale keys must never leak
      // (and a stored key from the OLD backend must not survive into the new
      // one: hasStoredApiKey resets with it — the user re-enters a key).
      if (patch.backend !== undefined && patch.backend !== prev.backend) {
        const nextBackend = patch.backend;
        const nextVoiceId = nextBackend === TTS_BACKEND.Kokoro ? "af_heart" : "";
        // TE2-8 preset glue: when the patch carries a preset-bearing config
        // (Cloud applyPreset), keep that config instead of wiping to {}.
        const preset = patch.config?.[TTS_PRESET_CONFIG_KEY];
        const nextConfig =
          patch.config !== undefined && typeof preset === "string" && preset.length > 0 ? { ...patch.config } : {};
        return { ...prev, ...patch, config: nextConfig, apiKey: "", providerRef: null, voiceId: nextVoiceId, narratorVoiceId: "", hasStoredApiKey: false };
      }
      return { ...prev, ...patch };
    });
    setDirty(true);
  }, []);

  const cancelEdit = useCallback(() => {
    if (editingId) {
      const record = profiles.find((p) => p.id === editingId);
      if (record) {
        setFormState({
          id: record.id,
          name: record.name,
          backend: toBackendSlug(record.backend),
          config: { ...record.config },
          apiKey: "",
          providerRef: record.providerRef ?? null,
          voiceId: record.voiceId ?? "",
          narratorVoiceId: record.narratorVoiceId ?? "",
          hasStoredApiKey: record.hasStoredApiKey,
        });
      }
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
    if (trimmedName.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      let saved: TtsProfileRecord;
      // TE2-16: the typed form key rides the top-level write-only field.
      // Update with a BLANK key sends undefined = keep the stored one (the
      // key field's placeholder communicates that); create treats blank as
      // absent. `config` itself is sent bag-only — no secret inside, ever.
      const apiKeyPayload = form.apiKey.trim() === "" ? undefined : form.apiKey.trim();
      if (form.id === null) {
        saved = await createTtsProfile({
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          apiKey: apiKeyPayload,
          voiceId: form.voiceId,
          narratorVoiceId: form.narratorVoiceId.trim() === "" ? null : form.narratorVoiceId,
        });
      } else {
        saved = await updateTtsProfile(form.id, {
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          apiKey: apiKeyPayload,
          voiceId: form.voiceId,
          narratorVoiceId: form.narratorVoiceId.trim() === "" ? null : form.narratorVoiceId,
        });
      }
      const list = await listAllTtsProfiles();
      setProfiles(list);
      setEditingId(saved.id);
      setFormState({
        id: saved.id,
        name: saved.name,
        backend: toBackendSlug(saved.backend),
        config: { ...saved.config },
        apiKey: "",
        providerRef: saved.providerRef ?? null,
        voiceId: saved.voiceId ?? "",
        narratorVoiceId: (saved as unknown as { narratorVoiceId?: string | null }).narratorVoiceId ?? "",
        hasStoredApiKey: saved.hasStoredApiKey,
      });
      setDirty(false);
      setHeaderMode("view");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [form]);

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
      await deleteTtsProfile(form.id);
      const list = await listAllTtsProfiles();
      setProfiles(list);
      setFormState(null);
      setEditingId(null);
      setDirty(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setSaving(false);
    }
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
    startEdit,
    setDefault,
    select,
    startCreate,
    setForm,
    save,
    remove,
    cancelEdit,
    reload,
  };
}
