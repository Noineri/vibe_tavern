import { BuildMode } from "./components/BuildMode.js";
import { ImportSurface } from "./components/ImportSurface.js";
import { PersonaModal } from "./components/PersonaModal.js";
import { PlayMode } from "./components/PlayMode.js";
import { PromptManagerModal } from "./components/PromptManagerModal.js";
import { ProviderModal } from "./components/ProviderModal.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { useRpPlatformApp } from "./hooks/use-rp-platform-app.js";

export function App() {
  const app = useRpPlatformApp();
  const isPlayMode = app.mode === "play";
  const importSurface = (
    <ImportSurface
      isImportDragActive={app.isImportDragActive}
      isImporting={app.isImporting}
      importNotice={app.importNotice}
      onDragOver={app.handleImportDragOver}
      onDragLeave={app.handleImportDragLeave}
      onDrop={app.handleImportDrop}
      onFileChange={app.handleImportInputChange}
    />
  );

  if (app.isLoading) {
    return (
      <div className="app">
        <main className="main" style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
          <div className="scene-note">Loading Claw Tavern...</div>
        </main>
      </div>
    );
  }

  if (app.loadError) {
    return (
      <div className="app">
        <main className="main" style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
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

  if (!app.snapshot) {
    return (
      <div className="app">
        <main className="main" style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
          <div style={{ display: "grid", gap: 12, maxWidth: 520, padding: 24, width: "100%" }}>
            <div className="build-section-title">Claw Tavern</div>
            <div className="build-section-sub">
              Import a character card or lorebook to create the first active snapshot for the web shell.
            </div>
            {importSurface}
          </div>
        </main>
      </div>
    );
  }

  const snapshot = app.snapshot;
  const activeChatId = app.activeChatId ?? snapshot.activeChat.id;
  const personaName = snapshot.persona?.name ?? "No persona";
  const providerConnected = app.connection.status === "connected";
  const switchMode = () => app.setMode(isPlayMode ? "build" : "play");
  const openPromptTrace = () => {
    app.setMode("build");
    app.setBuildTab("trace");
  };

  const shellSurface = isPlayMode ? (
    <PlayMode
      messageList={{
        characterName: snapshot.character.name,
        scenario: snapshot.character.scenario,
        branches: snapshot.branches,
        activeBranchId: snapshot.activeBranch.id,
        messages: snapshot.messages,
        pendingUserMessageContent: app.pendingUserMessageContent,
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
        onSelectVariant: (messageId, variantIndex) =>
          void app.handleSelectMessageVariant(messageId, variantIndex),
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
        onDraftChange: app.setDraft,
        onSend: () => void app.handleSend(),
        personas: app.personas,
        activePersonaId: app.snapshot?.persona?.id ?? null,
        onSetPersona: app.handleSetChatPersona,
      }}
    />
  ) : (
    <BuildMode
      activeTab={app.buildTab}
      characterId={snapshot.character.id}
      characterName={snapshot.character.name}
      description={snapshot.character.description}
      scenario={snapshot.character.scenario}
      systemPrompt={snapshot.character.systemPrompt}
      mesExample={snapshot.character.mesExample}
      alternateGreetings={snapshot.character.alternateGreetings}
      postHistoryInstructions={snapshot.character.postHistoryInstructions}
      creatorNotes={snapshot.character.creatorNotes}
      promptTraceCount={snapshot.promptTraceHistory.length}
      activeTrace={app.activePromptTrace}
      promptPayloadText={app.promptPayloadText}
      isSaving={app.isSavingCharacter}
      saveNotice={app.characterSaveNotice}
      importSurface={importSurface}
      onTabChange={app.setBuildTab}
      onSave={(draft) => void app.handleSaveCharacter(draft)}
    />
  );

  return (
    <div className="app">
      <Sidebar
        sidebarCollapsed={app.sidebarCollapsed}
        activeChatId={activeChatId}
        characterTabs={app.characterTabs}
        chats={snapshot.chats}
        personaName={personaName}
        onToggleCollapsed={() => app.setSidebarCollapsed(!app.sidebarCollapsed)}
        onSwitchChat={(chatId) => void app.handleSwitchChat(chatId)}
        onOpenPromptManager={app.openPromptManager}
        onOpenPersonaManager={app.openPersonaModal}
      />

      <main className="main">
        <TopBar
          characterName={snapshot.character.name}
          characterSubtitle={snapshot.character.subtitle}
          activatedLoreCount={app.activePromptTrace?.activatedLoreEntries.length ?? 0}
          retrievedMemoryCount={app.activePromptTrace?.retrievedMemories.length ?? 0}
          providerLabel={app.activeProviderProfile?.name || "No provider"}
          providerModelLabel={app.activeProviderProfile?.defaultModel || app.connection.model || "No model selected"}
          providerConnected={providerConnected}
          mode={app.mode}
          theme={app.theme}
          onOpenProviderSettings={app.openConnectionPanel}
          onOpenTracePanel={openPromptTrace}
          onToggleMode={switchMode}
          onToggleTheme={() => app.setTheme(app.theme === "dark" ? "light" : "dark")}
        />

        {shellSurface}
      </main>

      <ProviderModal
        isOpen={app.isProviderModalOpen}
        connection={app.connection}
        connectionHint={app.renderConnectionHint()}
        connectionStatus={app.renderConnectionStatus()}
        providerProfiles={app.providerProfiles}
        selectedProviderProfileId={app.selectedProviderProfileId}
        activeProviderProfileId={app.activeProviderProfile?.id ?? null}
        onActivateProviderProfile={app.handleActivateProviderProfile}
        canConnect={app.canConnect}
        canRefreshModels={app.canRefreshModels}
        onClose={app.closeConnectionPanel}
        onSelectedProviderProfileChange={app.setSelectedProviderProfileId}
        onLoadProviderProfile={app.handleLoadProviderProfile}
        onConnectSavedProfile={app.handleConnectSavedProfile}
        onDeleteProviderProfile={app.handleDeleteProviderProfile}
        onPatchConnection={app.patchConnection}
        onConnect={app.handleConnect}
        onRefreshModels={app.handleRefreshProviderModels}
        onSaveProviderProfile={app.handleSaveProviderProfile}
      />

      <PromptManagerModal
        isOpen={app.isPromptManagerOpen}
        onClose={app.closePromptManager}
      />

      <PersonaModal
        isOpen={app.isPersonaModalOpen}
        personas={app.personas}
        activePersonaId={app.snapshot?.persona?.id ?? null}
        isSaving={app.isSavingCharacter}
        onClose={app.closePersonaModal}
        onSaveEdit={(personaId, draft) => void app.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void app.handleSetChatPersona(personaId)}
      />
    </div>
  );
}
