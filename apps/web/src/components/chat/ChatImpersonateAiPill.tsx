// "Speak as this persona" AI generation pill — shared by the desktop and
// mobile input areas. Streams an impersonated message into the draft via the
// ai-assistant endpoint, with a settings popover (provider/model/recent-count)
// that persists to uiSettings. Lives in its own file so that InputArea and
// MobileInputArea can both import it without an InputArea↔MobileInputArea
// import cycle.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AiQuickPill, type AiQuickSettings } from "../shared/AiQuickPill.js";
import { useT } from "../../i18n/context.js";
import { patchUiSettingsAction, useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { streamAiAssistant } from "../../api/ai-assistant-api.js";
import type { AiAssistantRequestBody } from "../../api/types.js";

export function ChatImpersonateAiPill({
  activeChatId,
  characterId,
  personaId,
  draft,
  setDraft,
  size,
  tone,
}: {
  activeChatId: string;
  characterId: string | null;
  personaId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  size?: "sm" | "md" | "lg";
  tone?: "neutral" | "info";
}) {
  const { t } = useT();
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const [settings, setSettings] = useState<AiQuickSettings>({
    providerId: "",
    modelName: "",
    recentMessageCount: 20,
  });
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The persisted pair seeds the pill ONCE, whole (provider + model together).
  // After that the pill's own settings are the only source — an empty model
  // means "this provider's default", never a model borrowed from the snapshot.
  useEffect(() => {
    if (settings.providerId || !bootstrapUiSettings) return;
    setSettings((s) => ({
      ...s,
      providerId: bootstrapUiSettings.aiAssistantProviderId ?? "",
      modelName: bootstrapUiSettings.aiAssistantModelName ?? "",
      enhanceDraft: bootstrapUiSettings.chatImpersonateEnhanceDraft,
    }));
  }, [settings.providerId, bootstrapUiSettings]);

  const handleGenerate = async () => {
    const { providerId, modelName } = settings;
    if (!activeChatId) return;
    if (!providerId) {
      toast.error(t("select_provider_first"));
      return;
    }
    setLoading(true);
    abortRef.current = new AbortController();
    try {
      const request: AiAssistantRequestBody = {
        mode: "chat_impersonate",
        instruction: "Write the next message as the current persona.",
        providerProfileId: providerId,
        model: modelName || undefined,
        enabledLayers: [
          ...(characterId ? ["character_base"] : []),
          ...(personaId ? ["persona"] : []),
        ],
        characterIds: characterId ? [characterId] : [],
        personaIds: personaId ? [personaId] : [],
        chatId: activeChatId,
        recentMessageCount: settings.recentMessageCount ?? 20,
        draftText: draft,
        enhanceDraft: settings.enhanceDraft ?? false,
      };
      let text = "";
      for await (const chunk of streamAiAssistant(request, { signal: abortRef.current.signal })) {
        if (chunk.type === "text" && chunk.text) {
          text += chunk.text;
          setDraft(text.trimStart());
        }
        if (chunk.type === "error" && chunk.error) throw new Error(chunk.error);
        if (chunk.type === "done") break;
      }
      if (text.trim()) setDraft(text.trim());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error(err instanceof Error ? err.message : "AI impersonation failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleSettingsChange = (s: AiQuickSettings) => {
    setSettings(s);
    // patchUiSettingsAction also refreshes the bootstrap store, so a remounted
    // pill seeds from what was saved, not from the page-load snapshot.
    void patchUiSettingsAction({
      aiAssistantProviderId: s.providerId || null,
      aiAssistantModelName: s.modelName || null,
      chatImpersonateEnhanceDraft: s.enhanceDraft ?? false,
    }).catch(() => {});
  };

  return (
    <AiQuickPill
      onGenerate={() => void handleGenerate()}
      onCancel={() => { abortRef.current?.abort(); }}
      onSettingsChange={handleSettingsChange}
      settings={settings}
      loading={loading}
      disabled={!activeChatId}
      showMessageCount
      showEnhanceDraftToggle
      starTooltip={t("ai_pill_impersonate")}
      gearTooltip={t("ai_pill_impersonate_settings")}
      size={size}
      tone={tone}
    />
  );
}
