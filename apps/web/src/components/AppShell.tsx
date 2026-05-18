import { useRef } from "react";
import { Toaster } from "sonner";
import { useT } from "../i18n/context.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { useChatStore, useNavigationStore, useCharacterStore, useProviderStore, useModalStore } from "../stores/index.js";
import { useActiveTrace } from "../stores/chat-selectors.js";
import { useBootstrapQuery, usePersonasQuery } from "../queries/bootstrap-queries.js";
import { useSaveChatSummaryMutation, useSummarizeChatMutation } from "../queries/chat-queries.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { useCharacterController } from "../hooks/use-character-controller.js";
import { useProviderProfiles } from "../hooks/use-provider-profiles.js";
import { usePresetController } from "../hooks/use-preset-controller.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import { PlayMode } from "./PlayMode.js";
import { BuildMode } from "./BuildMode.js";
import { ContextMemoryModal } from "./ContextMemoryModal.js";
import { CreateCharacterModal } from "./CreateCharacterModal.js";
import { PersonaModal } from "./PersonaModal.js";
import { PromptManagerModal } from "./PromptManagerModal.js";
import { ProviderModal } from "./ProviderModal.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import { ShellDestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { TweaksPanel } from "./popovers/TweaksPanel.js";
import { AvatarPanel } from "./popovers/AvatarPanel.js";
import type { AppSnapshot } from "../app-client.js";
import type { TweaksSettings } from "../lib/local-storage.js";

interface AppShellProps {
  snapshot: AppSnapshot | null;
  tweaksSettings: TweaksSettings;
  setTweaksSettings: React.Dispatch<React.SetStateAction<TweaksSettings>>;
}

export function AppShell({ snapshot, tweaksSettings, setTweaksSettings }: AppShellProps) {
  const { t, setLocale } = useT();

  // --- Store subscriptions (reactive) ---
  const mode = useNavigationStore((s) => s.mode);
  const theme = useNavigationStore((s) => s.theme);
  const setTheme = useNavigationStore((s) => s.setTheme);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const draft = useChatStore((s) => s.draft);
  const isSending = useChatStore((s) => s.isSending);
  const editingDraft = useChatStore((s) => s.editingDraft);
  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);
  const confirmDestroy = useCharacterStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);
  const renamingChatId = useCharacterStore((s) => s.renamingChatId);
  const setRenamingChatId = useCharacterStore((s) => s.setRenamingChatId);
  const renameDraft = useCharacterStore((s) => s.renameDraft);
  const setRenameDraft = useCharacterStore((s) => s.setRenameDraft);

  // Modal store
  const tweaksOpen = useModalStore((s) => s.tweaksOpen);
  const setTweaksOpen = useModalStore((s) => s.setTweaksOpen);
  const avatarOpen = useModalStore((s) => s.avatarOpen);
  const setAvatarOpen = useModalStore((s) => s.setAvatarOpen);
  const isContextMemoryOpen = useModalStore((s) => s.isContextMemoryOpen);
  const setContextMemoryOpen = useModalStore((s) => s.setContextMemoryOpen);
  const isProviderModalOpen = useModalStore((s) => s.isProviderModalOpen);
  const setIsProviderModalOpen = useModalStore((s) => s.setIsProviderModalOpen);
  const isPromptManagerOpen = useModalStore((s) => s.isPromptManagerOpen);
  const setIsPromptManagerOpen = useModalStore((s) => s.setIsPromptManagerOpen);
  const isPersonaModalOpen = useModalStore((s) => s.isPersonaModalOpen);
  const setIsPersonaModalOpen = useModalStore((s) => s.setIsPersonaModalOpen);
  const isCreateCharacterModalOpen = useModalStore((s) => s.isCreateCharacterModalOpen);
  const setCreateCharacterModalOpen = useModalStore((s) => s.setCreateCharacterModalOpen);

  // --- Sub-hooks (self-contained) ---
  const bootstrapQuery = useBootstrapQuery();
  const personasQuery = usePersonasQuery();
  const chat = useChatController();
  const character = useCharacterController();
  const provider = useProviderProfiles();
  const preset = usePresetController();

  const personas = personasQuery.data ?? [];
  const promptPresets = bootstrapQuery.data?.promptPresets ?? [];
  const isFirstRun = (bootstrapQuery.data?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === 'true';
  const activePromptPresetId = snapshot?.activeChat.promptPresetId ?? null;

  // Prompt trace from normalized store
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const connection = useProviderStore((s) => s.connection);
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  // --- Summary mutations (local to AppShell) ---
  const summarizeChatMut = useSummarizeChatMutation();
  const saveChatSummaryMut = useSaveChatSummaryMutation();

  async function handleSummarizeChat(input: { providerProfileId: string; model?: string; maxMessages: number }): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await summarizeChatMut.mutateAsync({ chatId, input });
    return result.summary;
  }

  async function handleSaveChatSummary(summary: string): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await saveChatSummaryMut.mutateAsync({ chatId, summary });
    return result.summary;
  }

  // --- Tweak helpers ---
  function updateTweak(key: string, value: unknown): void {
    setTweaksSettings(prev => {
      const next = { ...prev, [key]: value };
      return next;
    });
  }

  // --- Derived values for rendering ---
  const resolvedActiveChatId = activeChatId ?? snapshot?.activeChat.id ?? null;
  const contextUsed = activePromptTrace?.tokenAccounting?.total ?? 0;
  const contextLimit = provider.activeProviderProfile?.contextBudget ?? 0;

  const isPlayMode = mode === "play";
  // canUseLiveApi derived above

  let shellSurface: React.ReactNode;

  if (!snapshot) {
    shellSurface = (
      <div className="flex flex-1 items-center justify-center">
        <div className="scene-note">{isFirstRun ? "" : t("select_character_start_chat")}</div>
      </div>
    );
  } else if (isPlayMode) {
    shellSurface = <PlayMode />;
  } else {
    shellSurface = <BuildMode />;
  }

  // AvatarPanel shows the full-size original image (for zoom/pan preview)
  // Falls back to the cropped avatar if no separate full asset exists
  const avatarSrc = snapshot?.character.avatarFullAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarFullAssetId}`
    : snapshot?.character.avatarAssetId
      ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarAssetId}`
      : undefined;

  const tweaksPanelSettings = {
    theme: theme as 'dark' | 'light',
    fontSize: tweaksSettings.fontSize,
    uiFontSize: tweaksSettings.uiFontSize,
    messageWidth: tweaksSettings.messageWidth,
    lang: tweaksSettings.lang,
  };

  const handleSetTweak = (key: string, value: unknown) => {
    if (key === 'theme') setTheme(value as 'dark' | 'light');
    else if (key === 'fontSize' || key === 'uiFontSize') updateTweak(key, value as number);
    else if (key === 'messageWidth') updateTweak(key, value as 'narrow' | 'medium' | 'wide');
    else if (key === 'lang') { updateTweak(key, value as string); setLocale(value as 'en' | 'ru'); }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        {shellSurface}
      </main>

      {tweaksOpen && <TweaksPanel settings={tweaksPanelSettings} setSetting={handleSetTweak} />}
      {avatarOpen && avatarSrc && <AvatarPanel src={avatarSrc} onClose={() => setAvatarOpen(false)} />}

      <ContextMemoryModal
        isOpen={isContextMemoryOpen} onClose={() => setContextMemoryOpen(false)}
        activeChatId={resolvedActiveChatId}
        providers={provider.providerProfiles.map(p => ({
          id: p.id,
          name: p.name,
          defaultModel: p.defaultModel,
          hasStoredApiKey: p.hasStoredApiKey,
          isActive: p.isActive,
        }))}
        contextWindow={{ used: contextUsed, limit: contextLimit }}
        currentSummary={snapshot?.activeChat.summary ?? ""}
        messageCount={snapshot?.messages.length ?? 0}
        onSummarize={handleSummarizeChat} onSaveSummary={handleSaveChatSummary}
        onFetchModelsForProfile={provider.handleFetchModelsForProfile}
      />

      <ProviderModal
        providerProfiles={provider.providerProfiles}
        activeProviderProfileId={provider.activeProviderProfile?.id ?? null}
        onCreateProfile={provider.handleCreateProviderProfile}
        onDuplicateProfile={provider.handleDuplicateProviderProfile}
        onDeleteProfile={async (id: string) => { await provider.handleDeleteProviderProfile(id); }}
        onActivateProfile={provider.handleActivateProviderProfile}
        onSaveProfile={provider.handleSaveProviderProfileFromForm}
        onTestDraft={provider.handleTestDraftConnection} onTestProfile={provider.handleTestProfileConnection}
        onTestChat={provider.handleTestChat}
        onFetchModels={provider.handleFetchModelsByEndpoint} onFetchModelsForProfile={provider.handleFetchModelsForProfile}
        favoriteModelsByProfile={provider.favoriteModelsByProfile}
        onToggleFavoriteModel={provider.handleToggleFavoriteProviderModel}
        onRefreshProfiles={async () => { await provider.handleRefreshProfiles(); }}
      />

      <PromptManagerModal
        presets={promptPresets} activePresetId={activePromptPresetId}
        setActivePresetId={preset.handleSetActivePromptPresetId}
        onCreate={preset.handleCreatePromptPreset} onUpdate={preset.handleUpdatePromptPreset}
        onDelete={preset.handleDeletePromptPreset}
        providerProfiles={provider.providerProfiles.map(p => ({ id: p.id, name: p.name }))}
        prefillSupported={!['anthropic', 'google', 'koboldcpp'].includes(provider.activeProviderProfile?.providerPreset ?? '')}
      />

      <PersonaModal
        personas={personas} activePersonaId={snapshot?.persona?.id ?? null}
        isSaving={character.isSavingCharacter}
        onSaveEdit={(personaId, draft) => void character.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void character.handleSetChatPersona(personaId)}
        onCreatePersona={character.handleCreatePersona} onDeletePersona={character.handleDeletePersona}
      />

      {isCreateCharacterModalOpen && (
        <CreateCharacterModal
          onClose={() => setCreateCharacterModalOpen(false)}
          onSave={async (data, avatarFile) => { const result = await character.handleCreateCharacter(data, avatarFile); setCreateCharacterModalOpen(false); return result; }}
        />
      )}

      <ShellDestructiveConfirmModal />
      <WelcomeScreen />
      <Toaster
        position="bottom-right"
        toastOptions={{ style: { background: "var(--s2)", color: "var(--t1)", border: "1px solid var(--border)" } }}
      />
    </div>
  );
}
