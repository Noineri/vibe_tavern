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
import { listProviderProfiles } from "../../../../api/provider-api.js";
import { listAllTtsProfiles } from "../../../../api/tts-api.js";
import {
  matchSttAutoKeyProviderName,
  type SttAutoKeyProviderCandidate,
  type SttAutoKeyTtsCandidate,
} from "./stt-form-helpers.js";

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
   *  (default-on key reuse) — drives the "key from «X»" hint on SAVED
   *  records. For the live draft the hook exposes
   *  `draftAutoKeyProviderName` (P2 — the STT port of the TTS F4/D21
   *  pattern): a server-decorated name wins, otherwise the client-side
   *  mirror resolves it pre-save. */
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
  /** P2 — the STT port of the TTS D21/F4 draft hint: auto-key resolution
   *  for the LIVE form (drafts included — the server decorates only saved
   *  records). A server-decorated name wins; otherwise the client-side
   *  mirror of the server hint rule (vendor match for gemini, endpoint
   *  match for openai-compat). Null when nothing matches. */
  draftAutoKeyProviderName: string | null;
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
  // P2: wire projections for the client-side auto-key hint — LLM providers
  //  (both branches) and TTS profiles (the gemini fallback). Hint-only
  //  data: a failed fetch degrades to "no hint" and never blocks the editor.
  const [autoKeyProviders, setAutoKeyProviders] = useState<SttAutoKeyProviderCandidate[]>([]);
  const [autoKeyTtsProfiles, setAutoKeyTtsProfiles] = useState<SttAutoKeyTtsCandidate[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providers, ttsProfiles] = await Promise.all([listProviderProfiles(), listAllTtsProfiles()]);
        if (cancelled) return;
        setAutoKeyProviders(providers.map((p) => ({ endpoint: p.endpoint, hasStoredApiKey: p.hasStoredApiKey, name: p.name })));
        setAutoKeyTtsProfiles(
          ttsProfiles.map((p) => ({ backend: p.backend, hasStoredApiKey: p.hasStoredApiKey, name: p.name })),
        );
      } catch (cause) {
        console.debug("[stt] auto-key hint: provider/tts list unavailable", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // P2: resolve the auto-key hint for the LIVE form. A server-decorated
  //  name (saved record) wins; drafts fall through to the client-side
  //  mirror of the server hint rule (see matchSttAutoKeyProviderName).
  const draftAutoKeyProviderName =
    form?.autoKeyProviderName !== null && form?.autoKeyProviderName !== undefined
      ? form.autoKeyProviderName
      : form === null || (form.backend !== STT_BACKENDS.Gemini && form.backend !== STT_BACKENDS.OpenAiCompat)
        ? null
        : matchSttAutoKeyProviderName(
            form.backend,
            typeof form.config.endpoint === "string" ? form.config.endpoint : "",
            autoKeyProviders,
            autoKeyTtsProfiles,
          );

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