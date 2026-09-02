import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_GEMINI_STT_MODEL,
  DEFAULT_WHISPER_MODEL_ID,
  STT_BACKENDS,
  STT_BACKEND_EMOTION_CAPABILITY,
  type SttBackendType,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import {
  createSttProfile,
  deleteSttProfile,
  listAllSttProfiles,
  setSttDefault,
  updateSttProfile,
  type SttProfileRecord,
} from "../../../../api/stt-api.js";

export interface SttProfileForm {
  id: string | null;
  name: string;
  backend: SttBackendType;
  config: Record<string, unknown>;
  /** Typed write-only API key (ST-1): lives in the form while editing,
   *  rides the top-level save field — NEVER inside `config`. Empty while
   *  editing a stored-key profile = keep the stored one on save (the
   *  server's tri-state: undefined=keep, ""=clear, non-empty=set). */
  apiKey: string;
  /** Server-computed hint: provider profile name whose endpoint auto-matches
   *  (default-on key reuse — providers then TTS profiles) — drives the
   *  "key from «X»" hint. Null when nothing matches. Server-decorated only:
   *  the client-side draft mirror exists for TTS (D21) but is deliberately
   *  skipped here — the STT tab is a mechanical fork and the hint on the
   *  saved record covers the real cases. */
  autoKeyProviderName: string | null;
  /** Mirror of the record's write-only flag (ST-1): true while editing a
   *  profile whose typed api_key column holds a key. Drives the key field's
   *  "saved" placeholder. */
  hasStoredApiKey: boolean;
  /** ST-7 emotion toggle — only capable backends (gemini) render it; the
   *  form value is forced false on every backend switch to a non-capable
   *  slug, and the server force-offs again on save (belt and braces). */
  emotionAnnotation: boolean;
}

/** Wire-boundary normalizer: the client stays defensive against unknown
 *  backend slugs, degrading to the zero-setup in-browser default — mirrors
 *  the TTS toBackendSlug rule without a blind cast. */
export function toSttBackend(raw: string): SttBackendType {
  for (const slug of Object.values(STT_BACKENDS)) {
    if (slug === raw) return slug;
  }
  return STT_BACKENDS.WhisperBrowser;
}

/** Editor screen state, mirroring the TTS headerMode: "view" = saved profile
 *  shown as the compact SttBaseCard with config fields below; "edit" = the
 *  connection form alone, entered via Edit settings / New. */
export type SttHeaderMode = "view" | "edit";

/** A fresh whisper-browser config: the roster default model — the config
 *  schema requires a non-empty model, so switching to the browser backend
 *  must always land on a valid one (startCreate + backend switch). */
function defaultWhisperConfig(): Record<string, unknown> {
  return { model: DEFAULT_WHISPER_MODEL_ID };
}

export function useSttProfiles(): {
  profiles: SttProfileRecord[];
  loading: boolean;
  editingId: string | null;
  form: SttProfileForm | null;
  dirty: boolean;
  error: string | null;
  saving: boolean;
  /** Current editor screen (TTS headerMode analog). */
  headerMode: SttHeaderMode;
  /** Open the connection form screen (Edit settings / New profile). */
  startEdit(): void;
  /** Mark a saved profile as the default transcription profile. */
  setDefault(id: string): Promise<void>;
  select(id: string): void;
  startCreate(): void;
  setForm(patch: Partial<SttProfileForm>): void;
  save(): Promise<void>;
  remove(): Promise<void>;
  cancelEdit(): void;
  reload(): Promise<void>;
} {
  const [profiles, setProfiles] = useState<SttProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setFormState] = useState<SttProfileForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [headerMode, setHeaderMode] = useState<SttHeaderMode>("view");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllSttProfiles();
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

  function hydrate(record: SttProfileRecord): SttProfileForm {
    return {
      id: record.id,
      name: record.name,
      backend: toSttBackend(record.backend),
      // record.config never carries the apiKey (ST-1 typed column) — the
      // key field starts empty and shows the "saved" placeholder instead.
      config: { ...record.config },
      apiKey: "",
      autoKeyProviderName: record.autoKeyProviderName ?? null,
      hasStoredApiKey: record.hasStoredApiKey,
      emotionAnnotation: record.emotionAnnotation,
    };
  }

  const select = useCallback(
    (id: string) => {
      const record = profiles.find((p) => p.id === id);
      if (!record) return;
      setEditingId(id);
      setFormState(hydrate(record));
      setDirty(false);
      setHeaderMode("view");
      setError(null);
    },
    [profiles],
  );

  const { t } = useT();
  // New profile starts with a localized default name (TTS D20 rule — the
  // owner had to invent one just to save-and-see the key hint).
  const startCreate = useCallback(() => {
    setEditingId(null);
    setFormState({
      id: null,
      name: t("stt_profile_default_name"),
      backend: STT_BACKENDS.WhisperBrowser,
      config: defaultWhisperConfig(),
      apiKey: "",
      autoKeyProviderName: null,
      hasStoredApiKey: false,
      emotionAnnotation: false,
    });
    setDirty(false);
    setHeaderMode("edit");
    setError(null);
  }, [t]);

  const startEdit = useCallback(() => setHeaderMode("edit"), []);

  const setDefault = useCallback(async (id: string) => {
    setError(null);
    try {
      await setSttDefault(id);
      const list = await listAllSttProfiles();
      setProfiles(list);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    }
  }, []);

  const setForm = useCallback((patch: Partial<SttProfileForm>) => {
    setFormState((prev) => {
      if (!prev) return prev;
      if (patch.backend !== undefined && patch.backend !== prev.backend) {
        const nextBackend = patch.backend;
        // Backend switch resets config + key — stale fields must never leak
        // across backends (a stored key from the OLD backend must not
        // survive into the new one: hasStoredApiKey resets with it). ST-7:
        // the emotion toggle resets too — it is a per-backend capability,
        // not a cross-backend preference.
        const nextConfig =
          nextBackend === STT_BACKENDS.WhisperBrowser
            ? defaultWhisperConfig()
            : nextBackend === STT_BACKENDS.Gemini
              ? { model: DEFAULT_GEMINI_STT_MODEL }
              : patch.config !== undefined
                ? { ...patch.config }
                : {};
        return {
          ...prev,
          ...patch,
          backend: nextBackend,
          config: nextConfig,
          apiKey: "",
          autoKeyProviderName: null,
          hasStoredApiKey: false,
          emotionAnnotation: STT_BACKEND_EMOTION_CAPABILITY[nextBackend] ? prev.emotionAnnotation : false,
        };
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
    if (trimmedName.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      let saved: SttProfileRecord;
      // ST-1: the typed form key rides the top-level write-only field.
      // Update with a BLANK key sends undefined = keep the stored one;
      // create treats blank as absent. `config` is sent bag-only. ST-7: the
      // emotion toggle rides create/update — forced false for non-capable
      // backends (the server force-offs again; belt and braces).
      const apiKeyPayload = form.apiKey.trim() === "" ? undefined : form.apiKey.trim();
      const emotionPayload = STT_BACKEND_EMOTION_CAPABILITY[form.backend] && form.emotionAnnotation;
      if (form.id === null) {
        saved = await createSttProfile({
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          apiKey: apiKeyPayload,
          emotionAnnotation: emotionPayload,
        });
      } else {
        saved = await updateSttProfile(form.id, {
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          apiKey: apiKeyPayload,
          emotionAnnotation: emotionPayload,
        });
      }
      const list = await listAllSttProfiles();
      setProfiles(list);
      setEditingId(saved.id);
      setFormState(hydrate(saved));
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
      await deleteSttProfile(form.id);
      const list = await listAllSttProfiles();
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