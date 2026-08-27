import { useCallback, useEffect, useState } from "react";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import {
  createTtsProfile,
  deleteTtsProfile,
  listAllTtsProfiles,
  updateTtsProfile,
  type TtsProfileRecord,
} from "../../../../api/tts-api.js";

export interface TtsProfileForm {
  id: string | null;
  name: string;
  backend: TtsBackendSlug;
  config: Record<string, unknown>;
  voiceId: string;
}

/** Wire-boundary normalizer: the server already degrades unknown backend
 *  slugs to kokoro on read, but the client stays defensive — mirrors that
 *  forward-compat rule without a blind cast. */
function toBackendSlug(raw: string): TtsBackendSlug {
  for (const slug of Object.values(TTS_BACKEND)) {
    if (slug === raw) return slug;
  }
  return TTS_BACKEND.Kokoro;
}

export function useTtsProfiles(): {
  profiles: TtsProfileRecord[];
  loading: boolean;
  editingId: string | null;
  form: TtsProfileForm | null;
  dirty: boolean;
  error: string | null;
  saving: boolean;
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
        config: { ...record.config },
        voiceId: record.voiceId ?? "",
      });
      setDirty(false);
      setError(null);
    },
    [profiles],
  );

  const startCreate = useCallback(() => {
    setEditingId(null);
    setFormState({ id: null, name: "", backend: TTS_BACKEND.Kokoro, config: {}, voiceId: "af_heart" });
    setDirty(false);
    setError(null);
  }, []);

  const setForm = useCallback((patch: Partial<TtsProfileForm>) => {
    setFormState((prev) => {
      if (!prev) return prev;
      // Backend switch resets config and voiceId — stale keys must never leak.
      if (patch.backend !== undefined && patch.backend !== prev.backend) {
        const nextBackend = patch.backend;
        const nextVoiceId = nextBackend === TTS_BACKEND.Kokoro ? "af_heart" : "";
        return { ...prev, ...patch, config: {}, voiceId: nextVoiceId };
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
          voiceId: record.voiceId ?? "",
        });
      }
      setDirty(false);
      setError(null);
      return;
    }
    setFormState(null);
    setDirty(false);
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
      if (form.id === null) {
        saved = await createTtsProfile({
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          voiceId: form.voiceId,
        });
      } else {
        saved = await updateTtsProfile(form.id, {
          name: trimmedName,
          backend: form.backend,
          config: form.config,
          voiceId: form.voiceId,
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
        voiceId: saved.voiceId ?? "",
      });
      setDirty(false);
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
    select,
    startCreate,
    setForm,
    save,
    remove,
    cancelEdit,
    reload,
  };
}
