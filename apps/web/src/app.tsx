import { BuildMode } from "./components/BuildMode.js";
import { ContextMemoryModal } from "./components/ContextMemoryModal.js";
import { CreateCharacterModal } from "./components/CreateCharacterModal.js";
import { PersonaModal } from "./components/PersonaModal.js";
import { PlayMode } from "./components/PlayMode.js";
import { PromptManagerModal } from "./components/PromptManagerModal.js";
import { ProviderModal } from "./components/ProviderModal.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { DestructiveConfirmModal } from "./components/shared/destructive-confirm-modal.js";
import { TweaksPanel } from "./components/popovers/TweaksPanel.js";
import { AvatarPanel } from "./components/popovers/AvatarPanel.js";
import { useRpPlatformApp } from "./hooks/use-rp-platform-app.js";
import { getGatewayBaseUrl } from "./gateway-client.js";

export function App() {
  const app = useRpPlatformApp();
  const isPlayMode = app.mode === "play";
  if (app.isLoading) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div className="font-body text-[12.5px] italic text-t3">Loading Claw Tavern...</div>
        </main>
      </div>
    );
  }

  if (app.loadError) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div style={{ display: "grid", gap: 12, maxWidth: 420, padding: 24 }}>
            <div className="build-section-title">Bootstrap failed</div>
            <div className="build-section-sub">{app.loadError}</div>
            <button className="api-save-btn" onClick={() => void app.loadBootstrap()}>
              Retry
            </button>
          </div>
        </main>
      </div>
    );
  }

  const snapshot = app.snapshot;
  const activeChatId = app.activeChatId ?? snapshot?.activeChat.id ?? null;
  const personaName = snapshot?.persona?.name ?? "No persona";
  const providerConnected = app.connection.status === "connected";
  const contextUsed = app.activePromptTrace?.tokenAccounting?.total ?? 0;
  const contextLimit = app.activeProviderProfile?.contextBudget ?? 0;
  const switchMode = () => app.setMode(isPlayMode ? "build" : "play");
  const openPromptTrace = () => {
    app.setMode("build");
    app.setBuildTab("trace");
  };

  const tweaksT = (key: string): string => {
    const map: Record<string, string> = {
      settings_interface: "Interface",
      twDark: "Dark theme",
      twFontSize: "Font size",
      twUiFontSize: "UI font size",
      twSmall: "Small",
      twMedium: "Medium",
      twLarge: "Large",
      twWidth: "Message width",
      twNarrow: "Narrow",
      twWide: "Wide",
      twLang: "Language",
    };
    return map[key] ?? key;
  };

  const tweaksPanelSettings = {
    theme: app.theme as 'dark' | 'light',
    fontSize: app.tweaksSettings.fontSize,
    uiFontSize: app.tweaksSettings.uiFontSize,
    messageWidth: app.tweaksSettings.messageWidth,
    lang: app.tweaksSettings.lang,
  };

  const handleSetTweak = (key: string, value: unknown) => {
    if (key === 'theme') {
      app.setTheme(value as 'dark' | 'light');
    } else if (key === 'fontSize' || key === 'uiFontSize') {
      app.updateTweak(key, value as number);
    } else if (key === 'messageWidth') {
      app.updateTweak(key, value as 'narrow' | 'medium' | 'wide');
    } else if (key === 'lang') {
      app.updateTweak(key, value as string);
    }
  };

  const avatarSrc = snapshot?.character.avatarAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarAssetId}`
    : undefined;

  let shellSurface: React.ReactNode;

  if (!snapshot) {
    shellSurface = (
      <div style={{ alignItems: "center", display: "flex", flex: 1, justifyContent: "center" }}>
        <div className="scene-note">{app.isFirstRun ? "" : "Select a character and start a new chat"}</div>
      </div>
    );
  } else if (isPlayMode) {
    shellSurface = (
    <PlayMode
      messageList={{
        characterName: snapshot.character.name,
        scenario: app.displayScenario,
        branches: snapshot.branches,
        activeBranchId: snapshot.activeBranch.id,
        messages: app.displayMessages,
        pendingUserMessageContent: app.displayPendingUserMessageContent,
        editingMessageId: app.editingMessageId,
        editingDraft: app.editingDraft,
        isSending: app.isSending,
        messageActionId: app.messageActionId,
        onActivateBranch: (branchId) => void app.handleActivateBranch(branchId),
        onFork: () => void app.handleFork(),
        onStartEdit: app.handleStartEdit,
        onEditingDraftChange: app.setEditingDraft,
        onCancelEdit: app.handleCancelEdit,
        onSaveEdit: (messageId) => void app.handleSaveMessageEdit(messageId),
        onDelete: (messageId) => void app.handleDeleteMessage(messageId),
        onRegenerate: (messageId) => void app.handleRegenerateMessage(messageId),
        onResend: () => {
          void app.handleResend();
        },
        onSelectVariant: (messageId, variantIndex) =>
          void app.handleSelectMessageVariant(messageId, variantIndex),
        alternateGreetings: snapshot.character.alternateGreetings,
        characterAvatarAssetId: snapshot.character.avatarAssetId ?? null,
        personaAvatarAssetId: snapshot.persona?.avatarAssetId ?? null,
      }}
      inputArea={{
        characterName: snapshot.character.name,
        personaName,
        draft: app.draft,
        tokenCount: app.draft.trim().length,
        sendLabel: app.renderSendLabel(),
        isSending: app.isSending,
        canSend: Boolean(app.draft.trim()) && !app.isSending && app.canUseLiveApi,
        notice: app.chatNotice,
        tokenAccounting: app.activePromptTrace?.tokenAccounting ?? {},
        onCancel: app.handleCancelGeneration,
        onDraftChange: app.setDraft,
        onSend: () => void app.handleSend(),
        personas: app.personas,
        activePersonaId: app.snapshot?.persona?.id ?? null,
        onSetPersona: app.handleSetChatPersona,
      }}
    />
  );
  } else {
    shellSurface = (
    <BuildMode
      activeTab={app.buildTab}
      characterId={snapshot.character.id}
      characterName={snapshot.character.name}
      description={snapshot.character.description}
      firstMessage={snapshot.character.firstMessage}
      scenario={snapshot.character.scenario}
      systemPrompt={snapshot.character.systemPrompt}
      subtitle={snapshot.character.subtitle}
      mesExample={snapshot.character.mesExample}
      alternateGreetings={snapshot.character.alternateGreetings}
      postHistoryInstructions={snapshot.character.postHistoryInstructions}
      creatorNotes={snapshot.character.creatorNotes}
      characterBook={snapshot.character.characterBook}
      depthPrompt={snapshot.character.depthPrompt}
      depthPromptDepth={snapshot.character.depthPromptDepth}
      depthPromptRole={snapshot.character.depthPromptRole}
      extensions={snapshot.character.extensions}
      tags={snapshot.character.tags}
      avatarAssetId={snapshot.character.avatarAssetId}
      promptTraceCount={snapshot.promptTraceHistory.length}
      activeTrace={app.activePromptTrace}
      promptPayloadText={app.promptPayloadText}
      isSaving={app.isSavingCharacter}
      saveNotice={app.characterSaveNotice}
      onSave={(draft) => void app.handleSaveCharacter(draft)}
      onAvatarUpload={(file) => void app.handleAvatarUpload(file)}
    />
  );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
      <Sidebar
        sidebarCollapsed={app.sidebarCollapsed}
        activeChatId={activeChatId}
        selectedCharacterId={app.selectedCharacterId}
        characterTabs={app.characterTabs}
        chats={snapshot?.chats ?? []}
        branches={snapshot?.branches ?? []}
        activeBranchId={snapshot?.activeBranch?.id ?? null}
        personaName={personaName}
        personaAvatarAssetId={snapshot?.persona?.avatarAssetId ?? null}
        activePromptTraceId={app.activePromptTraceId}
        onToggleCollapsed={() => app.setSidebarCollapsed(!app.sidebarCollapsed)}
        onSwitchChat={(chatId) => void app.handleSwitchChat(chatId)}
        onActivateBranch={(branchId) => void app.handleActivateBranch(branchId)}
        onFork={() => void app.handleFork()}
        onImportFiles={(files) => void app.handleImportFiles(files)}
        onOpenPromptManager={app.openPromptManager}
        onOpenPersonaManager={app.openPersonaModal}
        onOpenCreateCharacterModal={app.openCreateCharacterModal}
        onCreateChat={(characterId) => void app.onCreateChat(characterId)}
        onCloneChat={(chatId) => void app.onCloneChat(chatId)}
        onExportCharacter={(characterId) => void app.onExportCharacter(characterId)}
        onExportChatJsonl={(chatId) => void app.onExportChatJsonl(chatId)}
        onExportPromptTrace={(traceId) => void app.onExportPromptTrace(traceId)}
        renamingChatId={app.renamingChatId}
        renameDraft={app.renameDraft}
        onArchiveCharacter={(characterId) => void app.handleArchiveCharacter(characterId)}
        onDeleteCharacter={(characterId) => void app.handleDeleteCharacter(characterId)}
        onDeleteChat={(chatId) => void app.handleDeleteChat(chatId)}
        onRenameChat={(chatId, title) => void app.handleRenameChat(chatId, title)}
        onRenameStart={(chatId, title) => { app.setRenamingChatId(chatId); app.setRenameDraft(title); }}
        onRenameDraftChange={app.setRenameDraft}
        onRenameCancel={() => app.setRenamingChatId(null)}
        onRequestDestructiveConfirm={(config) => app.setConfirmDestroy(config)}
        onDeleteActiveBranch={() => void app.handleDeleteActiveBranch()}
        onSelectCharacter={(id) => app.setSelectedCharacterId(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          characterName={snapshot?.character.name ?? ""}
          characterAvatar={snapshot?.character.avatarAssetId ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarAssetId}` : undefined}
          characterSubtitle={snapshot?.character.subtitle ?? ""}
          activatedLoreCount={app.activePromptTrace?.activatedLoreEntries.length ?? 0}
          retrievedMemoryCount={app.activePromptTrace?.retrievedMemories.length ?? 0}
          providerLabel={app.activeProviderProfile?.name || "No provider"}
          providerModelLabel={app.activeProviderProfile?.defaultModel || app.connection.model || "No model selected"}
          providerConnected={providerConnected}
          mode={app.mode}
          theme={app.theme}
          onOpenProviderSettings={app.openConnectionPanel}
          onOpenTracePanel={openPromptTrace}
          onOpenContextMemory={app.openContextMemory}
          onToggleMode={switchMode}
          onToggleTheme={() => app.setTheme(app.theme === "dark" ? "light" : "dark")}
          onOpenAvatar={() => app.setAvatarOpen(true)}
          onToggleTweaks={() => app.setTweaksOpen(!app.tweaksOpen)}
          tweaksOpen={app.tweaksOpen}
        />

        {shellSurface}
      </main>

      {app.tweaksOpen && (
        <TweaksPanel
          settings={tweaksPanelSettings}
          setSetting={handleSetTweak}
          t={tweaksT}
        />
      )}

      {app.avatarOpen && avatarSrc && (
        <AvatarPanel
          src={avatarSrc}
          onClose={() => app.setAvatarOpen(false)}
        />
      )}

      <ContextMemoryModal
        isOpen={app.isContextMemoryOpen}
        onClose={app.closeContextMemory}
        activeChatId={activeChatId}
        providers={app.providerProfiles.map(p => ({ id: p.id, name: p.name, defaultModel: p.defaultModel, hasStoredApiKey: p.hasStoredApiKey, isActive: p.isActive }))}
        contextWindow={{ used: contextUsed, limit: contextLimit }}
        currentSummary={snapshot?.activeChat.summary ?? ""}
        messageCount={snapshot?.messages.length ?? 0}
        onSummarize={app.handleSummarizeChat}
        onSaveSummary={app.handleSaveChatSummary}
      />

      <ProviderModal
        isOpen={app.isProviderModalOpen}
        providerProfiles={app.providerProfiles}
        activeProviderProfileId={app.activeProviderProfile?.id ?? null}
        onClose={app.closeConnectionPanel}
        onCreateProfile={app.handleCreateProviderProfile}
        onDuplicateProfile={app.handleDuplicateProviderProfile}
        onDeleteProfile={async (id: string) => { await app.handleDeleteProviderProfile(id); }}
        onActivateProfile={app.handleActivateProviderProfile}
        onSaveProfile={app.handleSaveProviderProfileFromForm}
        onTestDraft={app.handleTestDraftConnection}
        onTestChat={app.handleTestChat}
        onFetchModels={app.handleFetchModelsByEndpoint}
        onRefreshProfiles={async () => { await app.handleRefreshProfiles(); }}
      />

      <PromptManagerModal
        isOpen={app.isPromptManagerOpen}
        onClose={app.closePromptManager}
        presets={app.promptPresets}
        activePresetId={app.activePromptPresetId}
        setActivePresetId={app.setActivePromptPresetId}
        onCreate={app.handleCreatePromptPreset}
        onUpdate={app.handleUpdatePromptPreset}
        onDelete={app.handleDeletePromptPreset}
        providerProfiles={app.providerProfiles.map(p => ({ id: p.id, name: p.name }))}
        prefillSupported={!['anthropic', 'google', 'koboldcpp'].includes(app.activeProviderProfile?.type ?? '')}
      />

      <PersonaModal
        isOpen={app.isPersonaModalOpen}
        personas={app.personas}
        activePersonaId={app.snapshot?.persona?.id ?? null}
        isSaving={app.isSavingCharacter}
        onClose={app.closePersonaModal}
        onSaveEdit={(personaId, draft) => void app.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void app.handleSetChatPersona(personaId)}
        onCreatePersona={app.handleCreatePersona}
        onDeletePersona={app.handleDeletePersona}
      />

      {app.isCreateCharacterModalOpen && (
        <CreateCharacterModal
          onClose={app.closeCreateCharacterModal}
          onSave={async (data, avatarFile) => {
            const result = await app.handleCreateCharacter(data, avatarFile);
            app.closeCreateCharacterModal();
            return result;
          }}
        />
      )}

      {app.confirmDestroy && (
        <DestructiveConfirmModal
          title={app.confirmDestroy.title}
          body={app.confirmDestroy.body}
          confirmLabel={app.confirmDestroy.confirmLabel}
          onConfirm={() => {
            app.confirmDestroy!.onConfirm();
            app.setConfirmDestroy(null);
          }}
          onCancel={() => app.setConfirmDestroy(null)}
        />
      )}

      {app.isFirstRun && (
        <WelcomeScreen
          onCreateCharacter={async (input) => { await app.handleCreateCharacter(input); }}
          onImportFiles={(files) => void app.handleImportFiles(files)}
          onFreeChat={() => app.handleFreeChat()}
        />
      )}
    </div>
  );
}
