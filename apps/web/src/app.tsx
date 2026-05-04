import { BuildMode } from "./components/BuildMode.js";
import { ImportSurface } from "./components/ImportSurface.js";
import { PersonaModal } from "./components/PersonaModal.js";
import { PlayMode } from "./components/PlayMode.js";
import { PromptManagerModal } from "./components/PromptManagerModal.js";
import { ProviderModal } from "./components/ProviderModal.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { DestructiveConfirmModal } from "./components/shared/destructive-confirm-modal.js";
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

  const snapshot = app.snapshot;
  const activeChatId = app.activeChatId ?? snapshot?.activeChat.id ?? null;
  const personaName = snapshot?.persona?.name ?? "No persona";
  const providerConnected = app.connection.status === "connected";
  const switchMode = () => app.setMode(isPlayMode ? "build" : "play");
  const openPromptTrace = () => {
    app.setMode("build");
    app.setBuildTab("trace");
  };

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
        onSelectVariant: (messageId, variantIndex) =>
          void app.handleSelectMessageVariant(messageId, variantIndex),
        alternateGreetings: snapshot.character.alternateGreetings,
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
  }

  return (
    <div className="app">
      <Sidebar
        sidebarCollapsed={app.sidebarCollapsed}
        activeChatId={activeChatId}
        characterTabs={app.characterTabs}
        chats={snapshot?.chats ?? []}
        branches={snapshot?.branches ?? []}
        activeBranchId={snapshot?.activeBranch?.id ?? null}
        personaName={personaName}
        activePromptTraceId={app.activePromptTraceId}
        onToggleCollapsed={() => app.setSidebarCollapsed(!app.sidebarCollapsed)}
        onSwitchChat={(chatId) => void app.handleSwitchChat(chatId)}
        onActivateBranch={(branchId) => void app.handleActivateBranch(branchId)}
        onFork={() => void app.handleFork()}
        onImportFiles={(files) => void app.handleImportFiles(files)}
        onOpenPromptManager={app.openPromptManager}
        onOpenPersonaManager={app.openPersonaModal}
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
      />

      <main className="main">
        <TopBar
          characterName={snapshot?.character.name ?? ""}
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
          onToggleMode={switchMode}
          onToggleTheme={() => app.setTheme(app.theme === "dark" ? "light" : "dark")}
        />

        {shellSurface}
      </main>

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
        onGetPersonalLorebookStatus={async (personaId) => {
          const { getPersonalLorebookStatus } = await import("./app-client.js");
          return getPersonalLorebookStatus(personaId);
        }}
        onSetPersonalLorebookEnabled={app.handleSetPersonalLorebook}
      />

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
          onCreateCharacter={(input) => app.handleCreateCharacter(input)}
          onImportFiles={(files) => void app.handleImportFiles(files)}
          onFreeChat={() => app.handleFreeChat()}
        />
      )}
    </div>
  );
}
