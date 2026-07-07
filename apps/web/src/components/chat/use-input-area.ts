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

import { useMemo, useRef } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { toast } from "sonner";
import type { PromptLayerDto } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { usePresetController } from "../../hooks/use-preset-controller.js";
import { useChatStore, useProviderStore, useIsSending } from "../../stores/index.js";
import { useActiveTrace, useChatMeta } from "../../stores/chat-selectors.js";
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

  // --- Attachments ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addDraftAttachment = useChatStore((s) => s.addDraftAttachment);
  const draftAttachments = useChatStore((s) => s.draftAttachments);

  const handleFileSelected = async (file: File) => {
    const validTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!validTypes.includes(file.type)) {
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
        id: crypto.randomUUID(),
        assetId,
        type: "image",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  };

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

  const canSend = Boolean(draft.trim() || draftAttachments.length > 0) && !isSending && canUseLiveApi;

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
    fileInputRef, draftAttachments, handleFileSelected, onFileInputChange, handlePaste,
    canSend, buckets, inputTokens,
  };
}

export type InputAreaData = ReturnType<typeof useInputArea>;
