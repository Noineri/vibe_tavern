// Shared data layer for the chat input area. Both the desktop branch
// (InputArea.tsx) and the mobile branch (MobileInputArea.tsx) consume the
// same controllers / store reads / file handlers / token buckets so that the
// viewport fork stays a pure presentational split — no duplicated state, no
// divergent wiring.
//
// This hook is the "everything before the `if (isMobile)` check" from the
// pre-fork InputArea, formalised. UI-only state (dropdown open-flags, drag
// hover, the mobile textarea auto-grow ref) is co-located with the branch
// that owns it; this hook holds only data + behaviour shared by both.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { toast } from "sonner";
import type { PromptLayerDto } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useChatController, diceSendBlockReason } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { usePresetController } from "../../hooks/use-preset-controller.js";
import { enqueueGenerateMore } from "../../hooks/use-generation-queue.js";
import { randomUUID } from "../../lib/uuid.js";
import { useChatStore, useProviderStore, useIsSending } from "../../stores/index.js";
import { useDiceLanes, useDiceStore } from "../../stores/dice-store.js";
import { useActiveTrace, useChatMeta, useActiveStreamingMessageId } from "../../stores/chat-selectors.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { uploadAsset } from "../../app-client.js";

export function useInputArea() {
  const { t } = useT();

  // --- Sub-hooks ---
  const chat = useChatController();
  const character = useCharacterController();
  const provider = useProviderProfiles();
  const preset = usePresetController();
  const bootstrapData = useBootstrapStore((s) => s.data);

  // --- Store subscriptions ---
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const isSending = useIsSending();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatMeta = useChatMeta();
  const connection = useProviderStore((s) => s.connection);

  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  const activePersonaId = chatMeta?.persona?.id ?? null;
  const promptPresets = bootstrapData?.promptPresets ?? [];
  const activePromptPresetId = chatMeta?.activeChat.promptPresetId ?? null;
  const contextSize = provider.activeProviderProfile?.contextBudget ?? 0;
  const maxTokens = provider.activeProviderProfile?.maxTokens ?? 0;
  const favoriteModels = provider.activeProviderProfile ? (provider.favoriteModelsByProfile[provider.activeProviderProfile.id] ?? []) : [];
  const activeModelId = provider.activeProviderProfile?.defaultModel ?? connection.model ?? null;

  // GMR (Generate-More Relocation): the in-flight streaming target for the
  // active chat. The composer's "Generate more" button (relocated from the
  // message header — see GENERATE_MORE_RELOCATION) enqueues another variant
  // onto THIS message. Null on idle → `showGenerateMore` is simply
  // `streamingMessageId !== null` (which also implies isSending, so the
  // Send/Cancel cluster is showing Cancel whenever this is true).
  const streamingMessageId = useActiveStreamingMessageId();
  const showGenerateMore = streamingMessageId !== null;
  // Snapshot model + preset as KEYS at enqueue time (Q1a — values resolve live
  // at pop). Same model resolution as the former MessageBlock handler: the
  // active provider profile's default model, falling back to the connection
  // model. Guarded — can't queue without a target message + model.
  const handleGenerateMore = (): void => {
    if (!streamingMessageId || !activeModelId) return;
    enqueueGenerateMore(streamingMessageId, activeModelId, activePromptPresetId);
  };

  // --- Attachments ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addDraftAttachment = useChatStore((s) => s.addDraftAttachment);
  const draftAttachments = useChatStore((s) => s.draftAttachments);

  // Image pickers stay image-typed; audio accepts the full ST-6 upload set
  // (the asset service normalizes `;codecs=` parameters away).
  const VALID_AUDIO_TYPES = [
    "audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/m4a",
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/flac",
  ];

  const handleFileSelected = async (file: File) => {
    const mime = file.type.split(";", 1)[0].trim().toLowerCase();
    const validTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    const isAudio = VALID_AUDIO_TYPES.includes(mime);
    if (!validTypes.includes(mime) && !isAudio) {
      toast.error(t("unsupported_image_format"));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error(t("file_too_large"));
      return;
    }
    if (draftAttachments.length >= 5) {
      toast.error(t("max_attachments"));
      return;
    }

    try {
      const { assetId } = await uploadAsset(file);
      addDraftAttachment({
        id: randomUUID(),
        assetId,
        type: isAudio ? "audio" : "image",
        // Hand-picked audio files keep the picker's purpose default (voice)
        // — the record button is the only music/ambient producer in v1 UI.
        ...(isAudio ? { purpose: "voice" as const } : {}),
        name: file.name,
        mimeType: mime,
        sizeBytes: file.size,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  };

  /** Voice-record button landing (STT_PLAN ST-6): upload the recorded clip
   *  and add it as a voice-purpose audio draft attachment. Returns false on a
   *  rejection so the caller can surface the recorder/upload error. */
  const handleVoiceRecorded = useCallback(async (blob: Blob, durationMs: number): Promise<boolean> => {
    if (draftAttachments.length >= 5) {
      toast.error(t("max_attachments"));
      return false;
    }
    const mime = blob.type.split(";", 1)[0].trim().toLowerCase();
    if (!VALID_AUDIO_TYPES.includes(mime)) {
      toast.error(t("unsupported_audio_format"));
      return false;
    }
    const ext = mime === "audio/mpeg" || mime === "audio/mp3" ? "mp3"
      : mime === "audio/ogg" ? "ogg"
      : mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a" ? "m4a"
      : mime === "audio/wav" || mime === "audio/x-wav" ? "wav"
      : mime === "audio/flac" ? "flac"
      : "webm";
    try {
      const { assetId } = await uploadAsset(new File([blob], `voice-message.${ext}`, { type: mime }));
      addDraftAttachment({
        id: randomUUID(),
        assetId,
        type: "audio",
        purpose: "voice",
        durationMs,
        name: t("voice_message_name"),
        mimeType: mime,
        sizeBytes: blob.size,
      });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      return false;
    }
  }, [draftAttachments.length, addDraftAttachment, t]);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFileSelected(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          void handleFileSelected(file);
          break;
        }
      }
    }
  };

  // --- Dice send gate (DICE-F3) ---
  // Subtractive-only: when Dice is disabled, the lane is absent/empty, or there
  // is nothing bindable, diceBlockReason is null and canSend is byte-identical
  // to before. Dice can only ever subtract from canSend, never add.
  const diceEnabled = chatMeta?.activeChat?.insightsConfig?.diceEnabled ?? false;
  const diceMode = chatMeta?.activeChat?.insightsConfig?.diceMode ?? "normal";
  const activeBranchId = chatMeta?.activeBranch?.id ?? null;
  const activeCharacterId = chatMeta?.activeChat?.characterId ?? null;
  // Establish the pending-lane scope for dice-enabled chats so the gate (and the
  // F6 panel) reads a loaded lane. No-op (no fetch) for non-dice chats.
  useEffect(() => {
    if (!diceEnabled || !activeChatId || !activeBranchId) return;
    useDiceStore.getState().setScope(activeChatId, activeBranchId);
  }, [diceEnabled, activeChatId, activeBranchId]);
  const diceLanes = useDiceLanes(diceEnabled ? activeChatId : null, activeBranchId);
  const activeDiceLane = diceEnabled && diceLanes ? diceLanes[diceMode] : null;
  const diceBlockReason = diceSendBlockReason(activeDiceLane, activePersonaId, activeCharacterId);

  const canSend = Boolean(draft.trim() || draftAttachments.length > 0) && !isSending && canUseLiveApi && diceBlockReason === null;

  // --- Token counting from backend prompt trace layers ---
  const TEMPORARY_TYPES = new Set(["chat_history", "compaction"]);

  const buckets = useMemo(() => {
    const layers: PromptLayerDto[] = activePromptTrace?.layers ?? [];
    let system = 0, character = 0, persona = 0, lore = 0, memory = 0, tools = 0, history = 0;
    for (const layer of layers) {
      if (!layer.enabled || layer.position === "hidden_system") continue;
      const tokens = layer.tokenCount;
      if (TEMPORARY_TYPES.has(layer.sourceType)) {
        history += tokens;
      } else {
        switch (layer.sourceType) {
          case "prompt_preset":           system += tokens; break;
          case "character_system_prompt": system += tokens; break;
          case "character":               character += tokens; break;
          case "persona":                 persona += tokens; break;
          case "lore_entry":              lore += tokens; break;
          case "summary_memory":          memory += tokens; break;
          case "retrieval_memory":        memory += tokens; break;
          case "tool_profile":            tools += tokens; break;
          default:                        system += tokens; break;
        }
      }
    }
    return { system, character, persona, lore, memory, tools, history };
  }, [activePromptTrace?.layers]);

  const inputTokens = useTokenCount(draft);

  return {
    t,
    chat, character, provider, preset,
    draft, setDraft, isSending, activeChatId, chatMeta, canUseLiveApi,
    personas, activePersonaId, promptPresets, activePromptPresetId,
    contextSize, maxTokens, favoriteModels, activeModelId,
    fileInputRef, draftAttachments, handleFileSelected, handleVoiceRecorded, onFileInputChange, handlePaste,
    canSend, buckets, inputTokens,
    showGenerateMore, handleGenerateMore,
  };
}

export type InputAreaData = ReturnType<typeof useInputArea>;
