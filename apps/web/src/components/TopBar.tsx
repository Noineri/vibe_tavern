import { useEffect, useRef, useState } from "react";
import { Icons } from "./shared/icons.js";
import { MemBadge } from "./popovers/MemBadge.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";
import { useProviderProfiles } from "../hooks/use-provider-profiles.js";
import { usePresetController } from "../hooks/use-preset-controller.js";
import { useNavigationStore, useProviderStore, useChatStore, useModalStore } from "../stores/index.js";
import { useActiveTrace } from "../stores/chat-selectors.js";
import { useBootstrapQuery } from "../queries/bootstrap-queries.js";
import { useChatSnapshot } from "../queries/chat-queries.js";
import { getGatewayBaseUrl } from "../gateway-client.js";

export function TopBar() {
  const { t } = useT();

  // --- Sub-hooks ---
  const provider = useProviderProfiles();
  const preset = usePresetController();
  const bootstrapQuery = useBootstrapQuery();

  // --- Store subscriptions ---
  const mode = useNavigationStore((s) => s.mode);
  const theme = useNavigationStore((s) => s.theme);
  const connection = useProviderStore((s) => s.connection);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const snapshotQuery = useChatSnapshot(activeChatId);
  const snapshot = snapshotQuery.data ?? null;

  const promptPresets = bootstrapQuery.data?.promptPresets ?? [];
  const activePromptPresetId = snapshot?.activeChat.promptPresetId ?? null;

  // --- Derived ---
  const characterName = snapshot?.character.name ?? "";
  const characterSubtitle = snapshot?.character.subtitle ?? "";
  const characterAvatar = snapshot?.character.avatarAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${snapshot.character.avatarAssetId}`
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

  // --- Local state ---
  const [presetDropOpen, setPresetDropOpen] = useState(false);
  const presetDropRef = useRef<HTMLDivElement>(null);
  const canSwitchPresets = promptPresets.length > 0;

  useEffect(() => {
    if (!presetDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetDropRef.current && !presetDropRef.current.contains(e.target as Node)) setPresetDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [presetDropOpen]);

  // --- Store actions ---
  const setMode = useNavigationStore((s) => s.setMode);

  return (
    <div className="sticky top-0 z-50 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-border bg-surface px-[22px]">
      <div className="flex min-w-[90px] max-w-[220px] flex-none items-center gap-2.5">
        <div className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top"
          onClick={() => useModalStore.getState().setAvatarOpen(true)}>
          {characterAvatar
            ? <img src={characterAvatar} alt={characterName}/>
            : <>{initials(characterName)}</>}
        </div>
        <div className="min-w-0 overflow-hidden">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{characterName}</div>
          <div className="mt-px max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">{characterSubtitle}</div>
        </div>
      </div>

      <div className="flex min-w-0 shrink items-center gap-[5px] flex-1 overflow-visible">
        {mode === 'play' && (
          <MemBadge label={t("topbar_memory")} onClick={() => useModalStore.getState().setContextMemoryOpen(true)} />
        )}

        <div className="flex min-h-8 min-w-0 max-w-[min(520px,60vw)] flex-[0_1_auto] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-transparent bg-transparent px-2 py-[3px] font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-t2 transition-colors duration-150 hover:border-border hover:bg-s2 hover:text-t1"
          onClick={() => useModalStore.getState().setIsProviderModalOpen(true)}
          title={t("provider_settings_title")}>
          <div className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
            connection.status === "error" ? "bg-danger" : providerConnected ? "bg-success" : "bg-t4",
          )}/>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-t1">{providerLabel}</span>
          <span className="text-t3">·</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2">{providerModelLabel || '—'}</span>
        </div>

        <span className="text-border2">|</span>

        <div ref={presetDropRef} className="relative">
          <div
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-[3px] font-ui text-[calc(var(--ui-fs)-4px)] font-medium uppercase leading-tight text-accent-t transition-colors",
              canSwitchPresets ? "cursor-pointer hover:bg-accent-dim" : "cursor-default"
            )}
            onClick={() => canSwitchPresets && setPresetDropOpen((v) => !v)}
            title={t("topbar_prompt_preset")}
          >
            <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">{activePresetName}</span>
            {canSwitchPresets && (
              <span className={cn("text-t3 transition-transform", presetDropOpen && "rotate-90")}><Icons.Caret direction="d" /></span>
            )}
          </div>
          {presetDropOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_12px_36px_rgba(0,0,0,.45)]">
              {promptPresets.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "cursor-pointer truncate px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] transition-colors hover:bg-s2",
                    p.id === activePromptPresetId ? "bg-accent-dim text-accent-t" : "text-t2"
                  )}
                  onClick={() => {
                    void preset.handleSetActivePromptPresetId(p.id);
                    setPresetDropOpen(false);
                  }}
                >
                  {p.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-2"/>

        <div className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-accent-t transition-colors duration-150 hover:bg-accent-hover"
          tabIndex={0}
          onClick={() => setMode(mode === 'play' ? 'build' : 'play')}>
          {mode === 'play' ? t("topbar_build_mode") : t("topbar_play_mode")}
        </div>

        <div className={cn("flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1", tweaksOpen && "bg-accent-dim text-accent-t")}
          tabIndex={0}
          title={t("topbar_interface_settings")}
          onClick={() => useModalStore.getState().setTweaksOpen(!tweaksOpen)}>
          <Icons.Settings />
        </div>
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
