import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { getT } from "../i18n/locale-helpers.js";
import type { ConnectionState } from "../components/layout/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useNavigationStore, useProviderStore, useChatStore } from "../stores/index.js";
import { useBootstrapStore, fetchBootstrapAction, fetchPersonasAction } from "../stores/api-actions/bootstrap-actions.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import {
  readSavedTheme,
  persistTheme,
  persistTweaks,
  readSavedTweaks,
  type TweaksSettings,
  MESSAGE_WIDTH_MAP,
} from "../lib/local-storage.js";
import { applyThemeClass } from "../themes/registry.js";
import { extractTokenFromHash, saveMobileToken, clearMobileToken } from "../lib/mobile-token.js";

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
    visionModel: "",
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
    showReasoning: false,
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
  const [loadError, setLoadError] = useState("");

  const isLoading = useBootstrapStore((s) => s.isLoading);
  const bootstrapData = useBootstrapStore((s) => s.data);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      // Extract mobile token from URL hash if present
      const hashToken = extractTokenFromHash();
      if (hashToken) {
        saveMobileToken(hashToken);
      }

      await Promise.all([
        fetchBootstrapAction(),
        fetchPersonasAction(),
      ]);
    } catch (err) {
      // If 401 and we have a stored token, it's invalid — clear it
      if (err instanceof Error && (err.message.includes("401") || err.message.includes("Unauthorized"))) {
        clearMobileToken();
      }
      setLoadError(err instanceof Error ? err.message : getT()("could_not_load_app_state"));
    }
  }, []);

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  // Primitive snapshot facts for small idempotent sync effects.
  const messageOrder = useSnapshotStore((s) => s.messageOrder);
  const promptTrace = useSnapshotStore((s) => s.promptTrace);

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
    applyThemeClass(root, theme);
    persistTheme(theme);
    // The pre-React splash in index.html paints by setting theme tokens
    // (--bg, --accent, --accent-mid) as inline styles on <html>. Those inline
    // values beat the theme CSS class in the cascade, so without clearing them
    // a live theme switch mixes colors (the old theme's tokens persist via
    // inline while the new theme only takes effect through its class). Remove
    // them once the real theme effect has run so the class is the sole source.
    root.style.removeProperty('--bg');
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-mid');
  }, [tweaksSettings, theme]);

  const promptTraceId = promptTrace?.id ?? null;

  // --- Keep selectedTraceId/editing state in sync with primitive snapshot facts ---
  useEffect(() => {
    // promptTrace is the single latest trace (history is lazy-loaded now,
    // TL-B2), so it is the only seed for selectedTraceId.
    const nextSelectedTraceId = promptTraceId ?? null;
    const chatState = useChatStore.getState();
    if (chatState.selectedTraceId !== nextSelectedTraceId) {
      chatState.setSelectedTraceId(nextSelectedTraceId);
    }

    if (!editingMessageId) return;
    const stillExists = messageOrder.includes(editingMessageId);
    if (!stillExists) {
      chatState.setEditingMessageId(null);
      if (chatState.editingDraft !== "") {
        chatState.setEditingDraft("");
      }
    }
  }, [promptTraceId, editingMessageId, messageOrder]);

  return {
    isLoading,
    loadError,
    retryLoad: load,
    tweaksSettings,
    setTweaksSettings,
  };
}
