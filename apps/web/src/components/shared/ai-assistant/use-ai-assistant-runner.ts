import { useCallback, useEffect, useRef, useState } from "react";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
import {
  streamAiAssistant,
  updateUiSettings,
  type AiAssistantRequestBody,
} from "../../../app-client.js";

/** MAE-22 wire shape: metadata the backend attaches to the stream `done`
 *  chunk for message-editor completions. `null` fields mean the backend
 *  emitted a bare `{ type: "done" }` (no metadata) — existing modes. */
export interface AiAssistantDoneMetadata {
  modelId: string | null;
  promptPresetId: string | null;
  finishReason: string | null;
}

export interface AiAssistantRunnerParams {
  isOpen: boolean;
  seedProviderId: string;
  seedModelName: string;
  persistSelection: boolean;
  onPartialJson?: (json: Record<string, unknown>) => void;
}

export interface AiAssistantRunner {
  providerId: string;
  modelName: string;
  providerModels: Array<{ id: string; label?: string }>;
  selectedProfile: ReturnType<typeof useProviderDataStore.getState>["profiles"][number] | undefined;
  streaming: boolean;
  streamedOutput: string;
  streamedReasoning: string;
  error: string | null;
  doneMetadata: AiAssistantDoneMetadata | null;
  handleProviderChange: (id: string) => void;
  handleModelChange: (id: string) => void;
  runStream: (request: AiAssistantRequestBody) => Promise<void>;
  stop: () => void;
  resetStreamState: () => void;
}

type ModelOption = { id: string; label?: string };

function extractModelList(response: unknown): ModelOption[] {
  if (response && typeof response === "object" && "models" in response) {
    const models = response.models;
    if (Array.isArray(models)) {
      return models.filter(
        (m): m is ModelOption =>
          m !== null && typeof m === "object" && typeof m.id === "string",
      );
    }
  }
  return [];
}

export function useAiAssistantRunner({
  isOpen,
  seedProviderId,
  seedModelName,
  persistSelection,
  onPartialJson,
}: AiAssistantRunnerParams): AiAssistantRunner {
  const providerProfiles = useProviderDataStore((s) => s.profiles);

  const [providerId, setProviderId] = useState("");
  const [modelName, setModelName] = useState("");
  const [providerModels, setProviderModels] = useState<ModelOption[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamedOutput, setStreamedOutput] = useState("");
  const [streamedReasoning, setStreamedReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneMetadata, setDoneMetadata] = useState<AiAssistantDoneMetadata | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const onPartialJsonRef = useRef(onPartialJson);
  useEffect(() => {
    onPartialJsonRef.current = onPartialJson;
  });

  useEffect(() => {
    if (!isOpen) return;
    setProviderId(seedProviderId);
    setModelName(seedModelName);
  }, [isOpen, seedProviderId, seedModelName]);

  useEffect(() => {
    if (!providerId) {
      setProviderModels([]);
      return;
    }
    let cancelled = false;
    void fetchProviderModelsAction(providerId).then((response: unknown) => {
      if (!cancelled) setProviderModels(extractModelList(response));
    });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const persistModelSelection = useCallback(
    (pId: string, mName: string | null) => {
      if (!persistSelection) return;
      void updateUiSettings({
        aiAssistantProviderId: pId || null,
        aiAssistantModelName: mName,
      }).catch(() => {});
    },
    [persistSelection],
  );

  const handleProviderChange = useCallback(
    (id: string) => {
      setProviderId(id);
      setModelName("");
      persistModelSelection(id, null);
    },
    [persistModelSelection],
  );

  const handleModelChange = useCallback(
    (id: string) => {
      setModelName(id);
      persistModelSelection(providerId, id || null);
    },
    [providerId, persistModelSelection],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const resetStreamState = useCallback(() => {
    setStreamedOutput("");
    setStreamedReasoning("");
    setError(null);
    setDoneMetadata(null);
  }, []);

  const runStream = useCallback(
    async (request: AiAssistantRequestBody) => {
      persistModelSelection(providerId, modelName || null);
      setError(null);
      setStreamedOutput("");
      setStreamedReasoning("");
      setDoneMetadata(null);
      setStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        for await (const chunk of streamAiAssistant(request, { signal: ac.signal })) {
          if (chunk.type === "reasoning" && chunk.text) {
            setStreamedReasoning((prev) => prev + chunk.text);
          }
          if (chunk.type === "text" && chunk.text) {
            setStreamedOutput((prev) => prev + chunk.text);
          }
          if (chunk.type === "partial_json" && chunk.json) {
            onPartialJsonRef.current?.(chunk.json);
          }
          if (chunk.type === "error" && chunk.error) {
            setError(chunk.error);
            setStreaming(false);
            return;
          }
          if (chunk.type === "done") {
            setDoneMetadata({
              modelId: chunk.modelId ?? null,
              promptPresetId: chunk.promptPresetId ?? null,
              finishReason: chunk.finishReason ?? null,
            });
            setStreaming(false);
            return;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(String(err));
        }
        setStreaming(false);
      }
    },
    [providerId, modelName, persistModelSelection],
  );

  const selectedProfile = providerProfiles.find((p) => p.id === providerId);

  return {
    providerId,
    modelName,
    providerModels,
    selectedProfile,
    streaming,
    streamedOutput,
    streamedReasoning,
    error,
    doneMetadata,
    handleProviderChange,
    handleModelChange,
    runStream,
    stop,
    resetStreamState,
  };
}
