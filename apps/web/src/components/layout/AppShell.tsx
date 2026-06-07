import { useRef, useEffect } from "react";
import { Toaster } from "sonner";
import { useT } from "../../i18n/context.js";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { useChatStore, useNavigationStore, useCharacterStore, useProviderStore, useModalStore, useIsSending } from "../../stores/index.js";
import { useActiveTrace } from "../../stores/chat-selectors.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { summarizeChatAction, saveChatSummaryAction } from "../../stores/api-actions/chat-actions.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { usePresetController } from "../../hooks/use-preset-controller.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Sidebar } from "./Sidebar.js";
import { Rail } from "./Rail.js";
import { TopBar } from "./TopBar.js";
import { PlayMode } from "../play/PlayMode.js";
import { BuildMode } from "../build/BuildMode.js";
import { ContextMemoryModal } from "../modals/ContextMemoryModal.js";
import { CreateCharacterModal } from "../modals/CreateCharacterModal.js";
import { PersonaModal } from "../modals/PersonaModal.js";
import { PromptManagerModal } from "../modals/PromptManagerModal.js";
import { ProviderModal } from "../modals/ProviderModal.js";
import { WelcomeScreen } from "../layout/WelcomeScreen.js";
import { ShellDestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { TweaksPanel } from "../settings/popovers/TweaksPanel.js";
import { MobileSettings } from "../settings/popovers/MobileSettings.js";
import { MobileAccessModal } from "../modals/MobileAccessModal.js";
import { AvatarPanel } from "../settings/popovers/AvatarPanel.js";
import type { TweaksSettings } from "../../lib/local-storage.js";

interface AppShellProps {
  tweaksSettings: TweaksSettings;
  setTweaksSettings: React.Dispatch<React.SetStateAction<TweaksSettings>>;
}

export function AppShell({ tweaksSettings, setTweaksSettings }: AppShellProps) {
  const { t, setLocale } = useT();

  // --- Store subscriptions (reactive) ---
  const isMobile = useIsMobile();
  const showRail = tweaksSettings.showRail;
  const mode = useNavigationStore((s) => s.mode);
  const theme = useNavigationStore((s) => s.theme);
  const setTheme = useNavigationStore((s) => s.setTheme);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeCharacter = useSnapshotStore((s) => s.character);
  const activePersona = useSnapshotStore((s) => s.persona);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const messageCount = useSnapshotStore((s) => s.messageOrder.length);
  const draft = useChatStore((s) => s.draft);
  const isSending = useIsSending();
  const editingDraft = useChatStore((s) => s.editingDraft);
  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
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
  const mobileAccessOpen = useModalStore((s) => s.mobileAccessOpen);
  const setMobileAccessOpen = useModalStore((s) => s.setMobileAccessOpen);
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
  const bootstrapData = useBootstrapStore((s) => s.data);
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  useEffect(() => { void fetchPersonasAction(); }, []);
  const chat = useChatController();
  const character = useCharacterController();
  const provider = useProviderProfiles();
  const preset = usePresetController();

  const promptPresets = bootstrapData?.promptPresets ?? [];
  const isFirstRun = (bootstrapData?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === 'true';
  const hasActiveSnapshot = Boolean(
    activeChatId &&
    activeChat?.id === activeChatId &&
    activeCharacter &&
    activeBranch,
  );
  const activePromptPresetId = activeChat?.promptPresetId ?? null;

  // Prompt trace from normalized store
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const connection = useProviderStore((s) => s.connection);
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  // --- Summary actions (local to AppShell) ---
  async function handleSummarizeChat(input: { providerProfileId: string; model?: string; maxMessages: number }): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await summarizeChatAction(chatId, input);
    return result.summary;
  }

  async function handleSaveChatSummary(summary: string): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await saveChatSummaryAction(chatId, summary);
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
  const resolvedActiveChatId = activeChatId ?? activeChat?.id ?? null;
  const contextUsed = activePromptTrace?.tokenAccounting?.total ?? 0;
  const contextLimit = provider.activeProviderProfile?.contextBudget ?? 0;

  const isPlayMode = mode === "play";
  // canUseLiveApi derived above

  let shellSurface: React.ReactNode;

  if (!hasActiveSnapshot) {
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
  const avatarSrc = activeCharacter?.avatarFullAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${activeCharacter.avatarFullAssetId}`
    : activeCharacter?.avatarAssetId
      ? `${getGatewayBaseUrl()}/api/assets/${activeCharacter.avatarAssetId}`
      : undefined;

  const tweaksPanelSettings = {
    theme: theme as 'dark' | 'light',
    fontSize: tweaksSettings.fontSize,
    uiFontSize: tweaksSettings.uiFontSize,
    messageWidth: tweaksSettings.messageWidth,
    lang: tweaksSettings.lang,
    showRail: tweaksSettings.showRail,
  };

  const handleSetTweak = (key: string, value: unknown) => {
    if (key === 'theme') setTheme(value as 'dark' | 'light');
    else if (key === 'showRail') updateTweak(key, value as boolean);
    else if (key === 'fontSize' || key === 'uiFontSize') updateTweak(key, value as number);
    else if (key === 'messageWidth') updateTweak(key, value as 'narrow' | 'medium' | 'wide');
    else if (key === 'lang') { updateTweak(key, value as string); setLocale(value as 'en' | 'ru'); }
  };

  return (
    <div className="flex bg-bg text-t1 font-ui" style={{ height: "100dvh", paddingBottom: "env(safe-area-inset-bottom, 0px)", overflow: "hidden" }}>
      {isMobile ? <Rail hidden={!showRail} /> : <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar railHidden={isMobile && !showRail} onShowRail={() => useNavigationStore.getState().triggerRailOpen()} />
        {shellSurface}
      </main>

      {tweaksOpen && <TweaksPanel settings={tweaksPanelSettings} setSetting={handleSetTweak} onClose={() => setTweaksOpen(false)} onOpenMobileAccess={async () => {
          // Ensure a token exists before opening the modal
          try {
            const resp = await fetch("/api/settings/mobile-access");
            if (resp.ok) {
              const data = await resp.json();
              if (!data.token) await fetch("/api/settings/mobile-access/regenerate", { method: "POST" });
            }
          } catch { /* ignore */ }
          setMobileAccessOpen(true);
        }} />}
      {isMobile && <MobileSettings
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
        settings={tweaksPanelSettings}
        setSetting={handleSetTweak}
        onOpenMobileAccess={async () => {
          try {
            const resp = await fetch("/api/settings/mobile-access");
            if (resp.ok) {
              const data = await resp.json();
              if (!data.token) await fetch("/api/settings/mobile-access/regenerate", { method: "POST" });
            }
          } catch { /* ignore */ }
          setMobileAccessOpen(true);
        }}
      />}
      {mobileAccessOpen && <MobileAccessModal open={mobileAccessOpen} onClose={() => setMobileAccessOpen(false)} onDisabled={() => {}} />}
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
        currentSummary={activeChat?.summary ?? ""}
        messageCount={messageCount}
        messageHistoryLimit={activeChat?.messageHistoryLimit ?? 0}
        autoSummaryConfig={activeChat?.autoSummaryConfig}
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
        personas={personas} activePersonaId={activePersona?.id ?? null}
        isSaving={character.isSavingCharacter}
        onSaveEdit={(personaId, draft) => void character.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void character.handleSetChatPersona(personaId)}
        onCreatePersona={character.handleCreatePersona} onDeletePersona={character.handleDeletePersona}
        onDuplicatePersona={character.handleDuplicatePersona}
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
        position={isMobile ? "top-center" : "bottom-right"}
        toastOptions={{ style: { background: "var(--s2)", color: "var(--t1)", border: "1px solid var(--border)" } }}
      />
    </div>
  );
}
