import { Icons } from "../shared/icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { MemBadge } from "../settings/popovers/MemBadge.js";
import { cn } from "../../lib/cn.js";
import * as Select from "@radix-ui/react-select";
import { useT } from "../../i18n/context.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { usePresetController } from "../../hooks/use-preset-controller.js";
import { useNavigationStore, useProviderStore, useChatStore, useModalStore } from "../../stores/index.js";
import { useActiveTrace, useChatMeta } from "../../stores/chat-selectors.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { MediaMenu } from "../chat/MediaMenu.js";
import { UpdateBadge } from "./UpdateBadge.js";

interface TopBarProps {
  railHidden?: boolean;
  onShowRail?: () => void;
  /** Latest version info from `useUpdateCheck`. Omitted when no update exists. */
  update?: { latestVersion: string; releaseUrl: string } | null;
}

export function TopBar({ railHidden, onShowRail, update }: TopBarProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  // --- Sub-hooks ---
  const provider = useProviderProfiles();
  const preset = usePresetController();
  const bootstrapData = useBootstrapStore((s) => s.data);

  // --- Store subscriptions ---
  const mode = useNavigationStore((s) => s.mode);
  const theme = useNavigationStore((s) => s.theme);
  const connection = useProviderStore((s) => s.connection);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatMeta = useChatMeta();

  const promptPresets = bootstrapData?.promptPresets ?? [];
  const activePromptPresetId = chatMeta?.activeChat.promptPresetId ?? null;

  // --- Derived ---
  const characterName = chatMeta?.character.name ?? "";
  const characterId = chatMeta?.character.id ?? null;
  const characterAvatar = chatMeta?.character
    ? resolveEntityAvatarUrl({ kind: "characters", id: chatMeta.character.id, avatarExt: chatMeta.character.avatarExt, avatarAssetId: chatMeta.character.avatarAssetId, updatedAt: chatMeta.character.updatedAt }) ?? undefined
    : undefined;
  const providerConnected = connection.status === "connected";
  const providerLabel = provider.activeProviderProfile?.name || t("no_provider");
  const providerModelId = provider.activeProviderProfile?.defaultModel || connection.model || null;
  const providerModelLabel = (providerModelId && connection.models.find((m) => m.id === providerModelId)?.label) || providerModelId || t("no_model_selected");
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const activatedLoreCount = activePromptTrace?.activatedLoreEntries.length ?? 0;
  const retrievedMemoryCount = activePromptTrace?.retrievedMemories.length ?? 0;
  const activePresetName = promptPresets.find((p) => p.id === activePromptPresetId)?.name ?? t("topbar_default");
  const tweaksOpen = useModalStore((s) => s.tweaksOpen);

  const canSwitchPresets = promptPresets.length > 0;

  // --- Store actions ---
  const setMode = useNavigationStore((s) => s.setMode);

  // ── Mobile: compact TopBar ──
  if (isMobile) {
    return (
      <div className="sticky top-0 z-50 flex h-[48px] shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3">
        {railHidden && (
          <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
               onClick={onShowRail}>
            <Icons.Menu />
          </div>
        )}
        <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)-2px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover "
          onClick={() => useModalStore.getState().setAvatarOpen(true)}>
          {characterAvatar
            ? <img src={characterAvatar} alt={characterName} className="h-full w-full object-cover"/>
            : <>{initials(characterName)}</>}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{characterName}</div>
        </div>
        {characterId && <MediaMenu characterId={characterId} characterName={characterName} />}
        {update && <UpdateBadge latestVersion={update.latestVersion} releaseUrl={update.releaseUrl} />}
        <div className="cursor-pointer rounded-full bg-mode-switch-bg px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-mode-switch-text transition-colors duration-150 hover:bg-mode-switch-hover-bg hover:text-mode-switch-hover-text"
          onClick={() => setMode(mode === 'build' ? 'play' : 'build')}>
          {mode === 'play' ? t("topbar_build_mode") : t("topbar_play_mode")}
        </div>
      </div>
    );
  }

  // ── Desktop ──
  return (
    <div className="sticky top-0 z-50 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-border bg-surface px-[22px]">
      <div className="flex min-w-[90px] max-w-[220px] flex-none items-center gap-2.5">
        <div className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover "
          onClick={() => useModalStore.getState().setAvatarOpen(true)}>
          {characterAvatar
            ? <img src={characterAvatar} alt={characterName} className="h-full w-full object-cover"/>
            : <>{initials(characterName)}</>}
        </div>
        <div className="min-w-0">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{characterName}</div>
          {characterId && <MediaMenu characterId={characterId} characterName={characterName} />}
        </div>
      </div>
      <div className="flex min-w-0 shrink items-center gap-[5px] flex-1 overflow-visible">
          {mode === 'play' && <MemBadge label={t("topbar_memory")} onClick={() => useModalStore.getState().setContextMemoryOpen(true)} />}

          <CustomTooltip content={t("provider_settings_title")}>
            <div className="flex min-h-8 min-w-0 max-w-[min(520px,60vw)] flex-[0_1_auto] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-transparent bg-transparent px-2 py-[3px] font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-t2 transition-colors duration-150 hover:border-border hover:bg-s2 hover:text-t1"
              onClick={() => useModalStore.getState().setIsProviderModalOpen(true)}>
              <div className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
                connection.status === "error" ? "bg-danger" : providerConnected ? "bg-success" : "bg-t4",
              )}/>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-t1">{providerLabel}</span>
              <span className="text-t3">·</span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2">{providerModelLabel || '—'}</span>
            </div>
          </CustomTooltip>

          <span className="text-border2">|</span>

          <Select.Root
            value={activePromptPresetId ?? undefined}
            onValueChange={(id) => { void preset.handleSetActivePromptPresetId(id); }}
          >
            <CustomTooltip content={t("topbar_prompt_preset")}>
              <Select.Trigger asChild disabled={!canSwitchPresets}>
                <div
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-[3px] font-ui text-[calc(var(--ui-fs)-4px)] font-medium uppercase leading-tight text-accent-t transition-colors",
                    canSwitchPresets ? "cursor-pointer hover:bg-accent-dim" : "cursor-default"
                  )}
                >
                  <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">{activePresetName}</span>
                  {canSwitchPresets && (
                    <span className="text-t3 transition-transform data-[state=open]:rotate-90"><Icons.Caret direction="r" /></span>
                  )}
                </div>
              </Select.Trigger>
            </CustomTooltip>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                className="glass-blur z-50 max-h-[calc(6*((var(--ui-fs)-2px)*1.5+0.75rem))] min-w-[180px] overflow-hidden rounded-lg border border-border bg-glass-bg shadow-[0_12px_36px_rgba(0,0,0,.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              >
                <Select.Viewport className="overflow-y-auto">
                  {promptPresets.map((p) => (
                    <Select.Item
                      key={p.id}
                      value={p.id}
                      className={cn(
                        "cursor-pointer truncate px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors outline-none data-[highlighted]:bg-s2 data-[state=checked]:bg-accent-dim data-[state=checked]:text-accent-t",
                      )}
                    >
                      <Select.ItemText>{p.name}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>

          <div className="flex-1 min-w-2"/>

          {update && <UpdateBadge latestVersion={update.latestVersion} releaseUrl={update.releaseUrl} />}

          <div className="cursor-pointer rounded-full bg-mode-switch-bg px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-mode-switch-text transition-colors duration-150 hover:bg-mode-switch-hover-bg hover:text-mode-switch-hover-text"
            tabIndex={0}
            onClick={() => setMode(mode === 'build' ? 'play' : 'build')}>
            {mode === 'play' ? t("topbar_build_mode") : t("topbar_play_mode")}
          </div>

          <CustomTooltip content={t("topbar_interface_settings")}>
            <div className={cn("flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1", tweaksOpen && "bg-accent-dim text-accent-t")}
              tabIndex={0}
              onClick={() => useModalStore.getState().setTweaksOpen(!tweaksOpen)}>
              <Icons.sliders />
            </div>
          </CustomTooltip>
        </div>
      </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
