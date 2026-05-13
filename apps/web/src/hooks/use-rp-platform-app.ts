import { useEffect, useLayoutEffect, useState } from "react";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useNavigationStore, useProviderStore, useChatStore, useModalStore } from "../stores/index.js";
import { useBootstrapQuery, usePersonasQuery } from "../queries/bootstrap-queries.js";
import { useChatSnapshot } from "../queries/chat-queries.js";
import {
  readSavedTheme,
  persistTheme,
  persistTweaks,
  readSavedTweaks,
  type TweaksSettings,
  MESSAGE_WIDTH_MAP,
} from "../lib/local-storage.js";

function createInitialConnectionState(): ConnectionState {
  const envDefaults = {
    providerLabel: import.meta.env.VITE_RP_DEFAULT_PROVIDER_LABEL || "OpenAI-compatible",
    baseUrl: import.meta.env.VITE_RP_DEFAULT_BASE_URL || "",
    model: import.meta.env.VITE_RP_DEFAULT_MODEL || "",
  };
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(envDefaults.baseUrl);

  return {
    providerLabel: envDefaults.providerLabel,
    baseUrl: normalizedBaseUrl,
    apiKey: "",
    model: envDefaults.model,
    activeProviderProfileId: null,
    hasStoredApiKey: false,
    status: "idle",
    error: "",
    models: [],
    providerType: PROVIDER_TYPE.openaiCompat,
    providerPreset: "",
    temperature: 1.0,
    topP: 1.0,
    minP: 0,
    topK: 0,
    topA: 0,
    frequencyPenalty: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.0,
    maxTokens: 2000,
    stopSequences: [],
    seed: null,
    reasoningEffort: "auto",
    streamResponse: true,
    customSamplers: false,
  };
}

/**
 * Thin bootstrap hook: loads persisted state, runs theme/CSS effects,
 * provides bootstrap query data for App.tsx loading/error screens.
 *
 * All business logic lives in sub-hooks:
 *   useChatController, useCharacterController, useProviderProfiles, usePresetController
 * Components import sub-hooks directly — not through this hook.
 */
export function useRpPlatformApp() {
  // --- Bootstrap + personas queries ---
  const bootstrapQuery = useBootstrapQuery();
  const personasQuery = usePersonasQuery();

  const isLoading = bootstrapQuery.status === "pending";
  const loadError = bootstrapQuery.status === "error"
    ? (bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : getT()("could_not_load_app_state"))
    : "";

  // Reactive snapshot for AppShell effects
  const activeChatId = useChatStore((s) => s.activeChatId);
  const snapshotQuery = useChatSnapshot(activeChatId);
  const snapshot = snapshotQuery.data ?? null;

  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
  const editingMessageId = useChatStore((s) => s.editingMessageId);

  const theme = useNavigationStore((s) => s.theme);

  // Local tweak state (not in a store — only needed by AppShell/TweaksPanel)
  const [tweaksSettings, setTweaksSettings] = useState<TweaksSettings>(() => readSavedTweaks());

  // --- Bootstrap: load persisted theme and connection defaults ---
  useLayoutEffect(() => {
    useNavigationStore.getState().setTheme(readSavedTheme());
    useProviderStore.getState().setConnection(createInitialConnectionState());
  }, []);

  // --- Theme + CSS effects ---
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mfs', `${tweaksSettings.fontSize}px`);
    root.style.setProperty('--ui-fs', `${tweaksSettings.uiFontSize}px`);
    root.style.setProperty('--mw', MESSAGE_WIDTH_MAP[tweaksSettings.messageWidth]);
    persistTweaks(tweaksSettings);
    root.classList.toggle("light", theme === "light");
    persistTheme(theme);
  }, [tweaksSettings, theme]);

  // --- Keep selectedTraceId in sync with snapshot ---
  useEffect(() => {
    useChatStore.getState().setSelectedTraceId(
      snapshot?.promptTrace?.id ?? snapshot?.promptTraceHistory[0]?.id ?? null,
    );
    if (!editingMessageId || !snapshot) return;
    const stillExists = snapshot.messages.some((message) => message.id === editingMessageId);
    if (!stillExists) {
      useChatStore.getState().setEditingMessageId(null);
      useChatStore.getState().setEditingDraft("");
    }
  }, [snapshot?.promptTrace?.id, snapshot?.promptTraceHistory, editingMessageId, snapshot]);

  return {
    isLoading,
    loadError,
    snapshot,
    tweaksSettings,
    setTweaksSettings,
  };
}
