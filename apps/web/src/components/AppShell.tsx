import { useRef } from "react";
import { Toaster } from "sonner";
import { useRpPlatformApp } from "../hooks/use-rp-platform-app.js";
import { useT } from "../i18n/context.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { useChatStore } from "../stores/index.js";
import { useNavigationStore } from "../stores/index.js";
import { useCharacterStore } from "../stores/index.js";
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
import { createContext, useContext } from "react";

type AppController = ReturnType<typeof useRpPlatformApp>;
const AppActionsContext = createContext<React.RefObject<AppController> | null>(null);

export function useAppActions(): AppController {
  const ref = useContext(AppActionsContext);
  if (!ref?.current) throw new Error("useAppActions must be used inside <App />");
  return ref.current;
}

export function AppShellProvider({ app, children }: { app: AppController; children: React.ReactNode }) {
  const appRef = useRef(app);
  appRef.current = app;
  return <AppActionsContext.Provider value={appRef}>{children}</AppActionsContext.Provider>;
}

export function AppShell() {
  const { t, setLocale } = useT();
  const app = useAppActions();

  const snapshot = app.snapshot;
  const isPlayMode = app.mode === "play";
  const activeChatId = app.activeChatId ?? snapshot?.activeChat.id ?? null;
  const contextUsed = app.activePromptTrace?.tokenAccounting?.total ?? 0;
  const contextLimit = app.activeProviderProfile?.contextBudget ?? 0;

  const tweaksPanelSettings = {
    theme: app.theme as 'dark' | 'light',
    fontSize: app.tweaksSettings.fontSize,
    uiFontSize: app.tweaksSettings.uiFontSize,
    messageWidth: app.tweaksSettings.messageWidth,
    lang: app.tweaksSettings.lang,
  };

  const handleSetTweak = (key: string, value: unknown) => {
    if (key === 'theme') app.setTheme(value as 'dark' | 'light');
    else if (key === 'fontSize' || key === 'uiFontSize') app.updateTweak(key, value as number);
    else if (key === 'messageWidth') app.updateTweak(key, value as 'narrow' | 'medium' | 'wide');
    else if (key === 'lang') { app.updateTweak(key, value as string); setLocale(value as 'en' | 'ru'); }
  };

  const avatarSrc = snapshot?.character.avatarAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarAssetId}`
    : undefined;

  let shellSurface: React.ReactNode;

  if (!snapshot) {
    shellSurface = (
      <div className="flex flex-1 items-center justify-center">
        <div className="scene-note">{app.isFirstRun ? "" : t("select_character_start_chat")}</div>
      </div>
    );
  } else if (isPlayMode) {
    shellSurface = <PlayMode />;
  } else {
    shellSurface = <BuildMode />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        {shellSurface}
      </main>

      {app.tweaksOpen && <TweaksPanel settings={tweaksPanelSettings} setSetting={handleSetTweak} />}
      {app.avatarOpen && avatarSrc && <AvatarPanel src={avatarSrc} onClose={() => app.setAvatarOpen(false)} />}

      <ContextMemoryModal
        isOpen={app.isContextMemoryOpen} onClose={app.closeContextMemory}
        activeChatId={activeChatId}
        providers={app.providerProfiles.map(p => ({
          id: p.id,
          name: p.name,
          defaultModel: p.defaultModel,
          hasStoredApiKey: p.hasStoredApiKey,
          isActive: p.isActive,
        }))}
        contextWindow={{ used: contextUsed, limit: contextLimit }}
        currentSummary={snapshot?.activeChat.summary ?? ""}
        messageCount={snapshot?.messages.length ?? 0}
        onSummarize={app.handleSummarizeChat} onSaveSummary={app.handleSaveChatSummary}
        onFetchModelsForProfile={app.handleFetchModelsForProfile}
      />

      <ProviderModal
        providerProfiles={app.providerProfiles}
        activeProviderProfileId={app.activeProviderProfile?.id ?? null}
        onCreateProfile={app.handleCreateProviderProfile}
        onDuplicateProfile={app.handleDuplicateProviderProfile}
        onDeleteProfile={async (id: string) => { await app.handleDeleteProviderProfile(id); }}
        onActivateProfile={app.handleActivateProviderProfile}
        onSaveProfile={app.handleSaveProviderProfileFromForm}
        onTestDraft={app.handleTestDraftConnection} onTestProfile={app.handleTestProfileConnection}
        onTestChat={app.handleTestChat}
        onFetchModels={app.handleFetchModelsByEndpoint} onFetchModelsForProfile={app.handleFetchModelsForProfile}
        favoriteModelsByProfile={app.favoriteModelsByProfile}
        onToggleFavoriteModel={app.handleToggleFavoriteProviderModel}
        onRefreshProfiles={async () => { await app.handleRefreshProfiles(); }}
      />

      <PromptManagerModal
        presets={app.promptPresets} activePresetId={app.activePromptPresetId}
        setActivePresetId={app.setActivePromptPresetId}
        onCreate={app.handleCreatePromptPreset} onUpdate={app.handleUpdatePromptPreset}
        onDelete={app.handleDeletePromptPreset}
        providerProfiles={app.providerProfiles.map(p => ({ id: p.id, name: p.name }))}
        prefillSupported={!['anthropic', 'google', 'koboldcpp'].includes(app.activeProviderProfile?.providerPreset ?? '')}
      />

      <PersonaModal
        personas={app.personas} activePersonaId={app.snapshot?.persona?.id ?? null}
        isSaving={app.isSavingCharacter}
        onSaveEdit={(personaId, draft) => void app.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void app.handleSetChatPersona(personaId)}
        onCreatePersona={app.handleCreatePersona} onDeletePersona={app.handleDeletePersona}
      />

      {app.isCreateCharacterModalOpen && (
        <CreateCharacterModal
          onClose={app.closeCreateCharacterModal}
          onSave={async (data, avatarFile) => { const result = await app.handleCreateCharacter(data, avatarFile); app.closeCreateCharacterModal(); return result; }}
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
