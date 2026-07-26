import { useRef, useState, useEffect } from "react";
import { Toaster, toast } from "sonner";
import * as Popover from "@radix-ui/react-popover";
import { useT } from "../../i18n/context.js";
import { normalizeLocale } from "../../i18n/registry.js";
import { Icons } from "../shared/icons.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { type ThemeMode } from "../../themes/registry.js";
import { useChatStore, useNavigationStore, useCharacterStore, useProviderStore, useModalStore, useIsSending } from "../../stores/index.js";
import { saveCharacterAction } from "../../stores/api-actions/character-actions.js";
import { useActiveTrace, useLazyContextPreview } from "../../stores/chat-selectors.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { summarizeChatAction, saveChatSummaryAction } from "../../stores/api-actions/chat-actions.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useGenerationQueue } from "../../hooks/use-generation-queue.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { usePresetController } from "../../hooks/use-preset-controller.js";
import { useUpdateCheck } from "../../hooks/use-update-check.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useShellSurface } from "../../hooks/use-shell-surface.js";
import { useChatEvents } from "../../hooks/use-chat-events.js";
import { ContextMemoryModal } from "../modals/ContextMemoryModal.js";
import { CreateCharacterModal } from "../modals/CreateCharacterModal.js";
import { PersonaModal } from "../modals/PersonaModal.js";
import { PromptManagerModal } from "../modals/PromptManagerModal.js";
import { ProviderModal } from "../modals/ProviderModal.js";
import { CoauthorProviderModal } from "../modals/CoauthorProviderModal.js";
import { SetupWizard } from "../layout/SetupWizard.js";
import { LavaBackground, useLavaBackgroundActive } from "./LavaBackground.js";
import { ShellDestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { TweaksPanel } from "../settings/popovers/TweaksPanel.js";
import { MobileSettings } from "../settings/popovers/MobileSettings.js";
import { MobileAccessModal } from "../modals/MobileAccessModal.js";
import { UpdateModal } from "../modals/UpdateModal.js";
import { CoauthorModuleModal } from "../coauthor/CoauthorModuleModal.js";
import { CoauthorSkillModal } from "../coauthor/CoauthorSkillModal.js";
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
  const theme = useNavigationStore((s) => s.theme);
  const setTheme = useNavigationStore((s) => s.setTheme);
  // WebGL lava-lamp overlay (progressive enhancement over the <body> gradient).
  // Only active for lava themes on wide screens with WebGL + motion allowed;
  // otherwise it renders nothing and the legacy CSS gradient shows through.
  const lavaActive = useLavaBackgroundActive(theme, tweaksSettings.lavaBlobs);
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
  const isCoauthorProviderModalOpen = useModalStore((s) => s.isCoauthorProviderModalOpen);
  const setCoauthorProviderModalOpen = useModalStore((s) => s.setCoauthorProviderModalOpen);
  const openProviderModalFromCoauthor = useModalStore((s) => s.openProviderModalFromCoauthor);
  const isPromptManagerOpen = useModalStore((s) => s.isPromptManagerOpen);
  const setIsPromptManagerOpen = useModalStore((s) => s.setIsPromptManagerOpen);
  const isPersonaModalOpen = useModalStore((s) => s.isPersonaModalOpen);
  const setIsPersonaModalOpen = useModalStore((s) => s.setIsPersonaModalOpen);
  const isCreateCharacterModalOpen = useModalStore((s) => s.isCreateCharacterModalOpen);
  const setCreateCharacterModalOpen = useModalStore((s) => s.setCreateCharacterModalOpen);
  const setUpdateModalOpen = useModalStore((s) => s.setUpdateModalOpen);

  // --- Sub-hooks (self-contained) ---
  const bootstrapData = useBootstrapStore((s) => s.data);
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  useEffect(() => { void fetchPersonasAction(); }, []);

  const chat = useChatController();
  // W7: subscribe to the per-chat SSE channel for background notifications
  // (auto-summary). No-op when no chat is active.
  useChatEvents(activeChatId);
  // Register the queue pump's runner (Q3) once runRegenerateJob is available.
  useGenerationQueue(chat.runRegenerateJob);
  const character = useCharacterController();
  const provider = useProviderProfiles();
  const preset = usePresetController();
  const updateCheck = useUpdateCheck(__APP_VERSION__);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) character.handleImportFiles(e.target.files);
    e.target.value = '';
  };

  // "Update available" toast — once per browser session (sessionStorage gate).
  // The TopBar badge stays visible all session; this is just the heads-up.
  useEffect(() => {
    if (!updateCheck.hasUpdate || !updateCheck.latestVersion || !updateCheck.releaseUrl) return;
    const FLAG = "vibe-tavern.update-toast-shown";
    try {
      if (sessionStorage.getItem(FLAG)) return;
      sessionStorage.setItem(FLAG, "1");
    } catch {
      return; // storage disabled — suppress rather than re-fire on every render
    }
    const message = t("update_available", { version: updateCheck.latestVersion });
    const openUpdateModal = () => setUpdateModalOpen(true);
    toast.custom(
      (id) => (
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t1">{message}</span>
          <button
            type="button"
            className="cursor-pointer rounded-md bg-accent px-2.5 py-1 text-[calc(var(--ui-fs)-3px)] font-semibold text-on-accent transition-[filter] hover:brightness-110"
            onClick={() => { openUpdateModal(); toast.dismiss(id); }}
          >
            {t("update_button")}
          </button>
        </div>
      ),
      { duration: 5000, style: { borderRadius: "var(--r)" } },
    );
  }, [updateCheck.hasUpdate, updateCheck.latestVersion, updateCheck.releaseUrl, t, setUpdateModalOpen]);

  const promptPresets = bootstrapData?.promptPresets ?? [];
  const [wizardVisible, setWizardVisible] = useState(false);
  const isFirstRun = (bootstrapData?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === 'true';
  const hasAnyCharacters = (bootstrapData?.allCharacters?.length ?? 0) > 0;

  const hasActiveSnapshot = Boolean(
    activeChatId &&
    activeChat?.id === activeChatId &&
    activeCharacter &&
    activeBranch,
  );
  const activePromptPresetId = activeChat?.promptPresetId ?? null;

  // Prompt trace from normalized store
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  // Lazy context-preview hydration: fetches the branch-scoped preview only when
  // no trace covers the active branch (the context-bar fallback). Mounted once
  // here so it follows the active (chatId, branchId) across all chat modes.
  useLazyContextPreview();
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

  // Shell dispatch via the chat-mode registry (SURFACE_REGISTRY step 2):
  // chatMode drives the package, navMode contributes only the play/build axis,
  // platform picks the rail/sidebar variant. Returns ready-to-render elements.
  // The empty-state guard below ignores shell.surface and renders a placeholder.
  const shell = useShellSurface({
    showRail,
    onShowRail: () => useNavigationStore.getState().triggerRailOpen(),
    update: updateCheck.hasUpdate && updateCheck.latestVersion && updateCheck.releaseUrl
      ? { latestVersion: updateCheck.latestVersion, releaseUrl: updateCheck.releaseUrl }
      : null,
  });

  let shellSurface: React.ReactNode;

  if (!hasActiveSnapshot && !wizardVisible) {
    if (hasAnyCharacters) {
      // Has characters/chats but none active — chat was just deleted, or user has not selected one yet.
      shellSurface = (
        <div className="flex h-full w-full items-center justify-center p-6">
          <p className="max-w-[420px] text-center font-ui text-[0.95rem] leading-relaxed text-t2">
            {t('placeholder_select_character_chat')}
          </p>
        </div>
      );
    } else {
    shellSurface = (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="flex max-w-[480px] flex-col items-center text-center">
          {/* Decorative icon */}
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/20 bg-accent-dim text-accent">
            <span className="text-[1.6rem]"><Icons.Sparkles /></span>
          </div>

          {/* Welcome text */}
          <h1 className="mb-2 font-body text-[1.5rem] font-medium tracking-tight text-t1">{t('placeholder_welcome')}</h1>
          <p className="mb-8 font-ui text-[0.95rem] leading-relaxed text-t2">{t('placeholder_hint')}</p>

          {/* Primary action */}
          <button
            type="button"
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 font-ui text-[1rem] font-bold text-on-accent shadow-lg shadow-accent/10 transition-all hover:brightness-110 active:scale-[0.98]"
            onClick={() => setCreateCharacterModalOpen(true)}
          >
            <span className="text-[0.95rem]"><Icons.Plus /></span>
            {t('placeholder_create_character')}
          </button>

          {/* Secondary action */}
          <button
            type="button"
            className="mb-6 flex w-full items-center justify-center gap-2 rounded-xl border border-border2 bg-s2 px-6 py-3 font-ui text-[0.95rem] font-semibold text-t1 transition-all hover:border-accent/50 hover:bg-surface"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="text-[0.9rem]"><Icons.Import /></span>
            {t('placeholder_import_character')}
          </button>
          <input ref={fileInputRef} type="file" accept=".png,.json,.md,.markdown,.vtmd" className="hidden" onChange={handleImportFile} />

          {/* Utility row */}
          <div className="grid w-full grid-cols-2 gap-3 border-t border-border/50 pt-5">
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 font-ui text-[0.85rem] text-t2 transition-colors hover:bg-accent-dim/30 hover:text-accent-t"
              onClick={() => { location.reload(); }}
            >
              <span className="text-[0.85rem]"><Icons.Settings /></span>
              {t('placeholder_setup_wizard')}
            </button>
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 font-ui text-[0.85rem] text-t2 transition-colors hover:bg-accent-dim/30 hover:text-accent-t"
              onClick={() => setIsProviderModalOpen(true)}
            >
              <span className="text-[0.85rem]"><Icons.Wrench /></span>
              {t('placeholder_setup_provider')}
            </button>
          </div>
        </div>
      </div>
    );
    }
  } else {
    // Central surface comes from the chat-mode registry hook (chatMode drives
    // the package). The empty-state guards above are unchanged — only the
    // mode-driven branch is delegated to the hook.
    shellSurface = shell.surface;
  }

  // AvatarPanel shows the full-size original image (for zoom/pan preview).
  // Folder avatar (avatarExt) wins; otherwise prefer the uncropped full asset
  // over the cropped one.
  const avatarSrc = activeCharacter
    ? resolveEntityAvatarUrl({ kind: "characters", id: activeCharacter.id, avatarExt: activeCharacter.avatarExt, avatarAssetId: activeCharacter.avatarAssetId, avatarFullAssetId: activeCharacter.avatarFullAssetId, updatedAt: activeCharacter.updatedAt, preferFull: true }) ?? undefined
    : undefined;

  const tweaksPanelSettings = {
    theme: theme as ThemeMode,
    fontSize: tweaksSettings.fontSize,
    uiFontSize: tweaksSettings.uiFontSize,
    messageWidth: tweaksSettings.messageWidth,
    lang: tweaksSettings.lang,
    showRail: tweaksSettings.showRail,
    lavaBlobs: tweaksSettings.lavaBlobs,
  };

  const handleSetTweak = (key: string, value: unknown) => {
    if (key === 'theme') setTheme(value as ThemeMode);
    else if (key === 'showRail') updateTweak(key, value as boolean);
    else if (key === 'lavaBlobs') updateTweak(key, value as boolean);
    else if (key === 'fontSize' || key === 'uiFontSize') updateTweak(key, value as number);
    else if (key === 'messageWidth') updateTweak(key, value as 'narrow' | 'medium' | 'wide');
    else if (key === 'lang') { updateTweak(key, value as string); setLocale(normalizeLocale(value as string)); }
  };

  // Root is intentionally transparent: the page background (solid --bg or a
  // --page-bg gradient, per theme) lives on <body> and shines through here.
  // Panels (Sidebar/TopBar/InputArea) carry their own opaque --surface; the
  // chat reading area stays transparent so the gradient shows. Do NOT add
  // bg-bg here — it masks --page-bg (see docs/guides/adding-a-theme.md).
  return (
    <div className="flex text-t1 font-ui" style={{ height: "100dvh", paddingBottom: "env(safe-area-inset-bottom, 0px)", overflow: "hidden" }}>
      {/* Portals a fixed full-screen <canvas> to <body> behind all content.
          No-op (renders null) unless lavaActive. See LavaBackground.tsx. */}
      <LavaBackground active={lavaActive} messageWidth={tweaksSettings.messageWidth} />
      {shell.leftChrome}
      {/* One Radix Popover.Root owns the desktop TweaksPanel: the Trigger lives
          in the mode-specific top bar (TopBar for rp, CoauthorTopBar for
          co-author — mutually exclusive, so exactly one Trigger renders), and
          the Content is <TweaksPanel> below. Radix anchors Content to the
          Trigger, animates open/close, and coordinates outside-click via the
          DismissableLayer stack (fixes the nested language DropdownSelect:
          see TweaksPanel.tsx). Mobile uses <MobileSettings> (a BottomSheet)
          driven by the same tweaksOpen flag — it renders outside this Root. */}
      <Popover.Root open={tweaksOpen} onOpenChange={setTweaksOpen}>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {shell.topBar}
          {shellSurface}
        </main>
        {!isMobile && (
          <TweaksPanel
            settings={tweaksPanelSettings}
            setSetting={handleSetTweak}
            onOpenMobileAccess={async () => {
              // Ensure a token exists before opening the modal
              try {
                const resp = await fetch("/api/settings/mobile-access");
                if (resp.ok) {
                  const data = await resp.json();
                  if (!data.token) await fetch("/api/settings/mobile-access/regenerate", { method: "POST" });
                }
              } catch { /* ignore */ }
              setMobileAccessOpen(true);
            }}
          />
        )}
      </Popover.Root>
      {shell.rightPanel}
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

      <CoauthorProviderModal
        isOpen={isCoauthorProviderModalOpen}
        onClose={() => setCoauthorProviderModalOpen(false)}
        onOpenProviderModal={openProviderModalFromCoauthor}
      />

      <PromptManagerModal
        presets={promptPresets} activePresetId={activePromptPresetId}
        setActivePresetId={preset.handleSetActivePromptPresetId}
        onCreate={preset.handleCreatePromptPreset} onUpdate={preset.handleUpdatePromptPreset}
        onDelete={preset.handleDeletePromptPreset} onReorder={preset.handleReorderPromptPresets}
        providerProfiles={provider.providerProfiles.map(p => ({ id: p.id, name: p.name }))}
        prefillSupported={!['anthropic', 'google', 'koboldcpp'].includes(provider.activeProviderProfile?.providerPreset ?? '')}
        characterFields={activeCharacter ? {
          systemPrompt: activeCharacter.systemPrompt ?? null,
          postHistoryInstructions: activeCharacter.postHistoryInstructions ?? null,
          depthPrompt: activeCharacter.depthPrompt ?? null,
          depthPromptDepth: activeCharacter.depthPromptDepth ?? null,
          depthPromptRole: activeCharacter.depthPromptRole ?? null,
        } : null}
        onCharacterFieldUpdate={(key, value) => {
          if (!activeCharacter) return;
          const apiFieldMap: Record<string, string> = {
            charSystemPrompt: "systemPrompt",
            charPostHistory: "postHistoryInstructions",
            charDepthPrompt: "depthPrompt",
            charDepthPromptDepth: "depthPromptDepth",
            charDepthPromptRole: "depthPromptRole",
          };
          const apiField = apiFieldMap[key];
          if (!apiField) return;
          void saveCharacterAction({
            characterId: activeCharacter.id,
            patch: { chatId: useChatStore.getState().activeChatId ?? undefined, [apiField]: value },
          });
        }}
      />

      <PersonaModal
        personas={personas} activePersonaId={activePersona?.id ?? null}
        isSaving={character.isSavingCharacter}
        onSaveEdit={(personaId, draft) => void character.handleSavePersona(personaId, draft)}
        onSetActive={(personaId) => void character.handleSetChatPersona(personaId)}
        onCreatePersona={character.handleCreatePersona} onDeletePersona={character.handleDeletePersona}
        onDuplicatePersona={character.handleDuplicatePersona}
        onSetDefaultPersona={character.handleSetDefaultPersona}
      />

      {isCreateCharacterModalOpen && (
        <CreateCharacterModal
          onClose={() => setCreateCharacterModalOpen(false)}
          onSave={async (data, avatarFile, avatarOriginalFile) => { const result = await character.handleCreateCharacter(data, avatarFile, avatarOriginalFile); setCreateCharacterModalOpen(false); return result; }}
        />
      )}

      <ShellDestructiveConfirmModal />
      <UpdateModal
        latestVersion={updateCheck.latestVersion}
        latestTag={updateCheck.latestTag}
        releaseUrl={updateCheck.releaseUrl}
        releaseNotes={updateCheck.releaseNotes}
      />
      <CoauthorModuleModal />
      <CoauthorSkillModal />
      <SetupWizard onVisibilityChange={setWizardVisible} />
      <Toaster
        position={isMobile ? "top-center" : "bottom-right"}
        toastOptions={{
          // glass-blur is a no-op in opaque themes (--glass-blur: 0) and frosts
          // the lava blobs behind the toast in glass themes. --glass-bg is the
          // translucent tint tuned to survive the blur (vs --s2, which reads
          // muddy when blurred).
          className: "glass-blur",
          style: { background: "var(--glass-bg)", color: "var(--t1)", border: "1px solid var(--border)" },
        }}
      />
    </div>
  );
}
