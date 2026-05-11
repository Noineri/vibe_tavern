import { useEffect, useRef, useState } from "react";
import type { AppMode, ConnectionStatus, ThemeMode } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";
import { MemBadge } from "./popovers/MemBadge.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";

interface TopBarProps {
  characterName: string;
  characterSubtitle: string;
  activatedLoreCount: number;
  retrievedMemoryCount: number;
  providerLabel: string;
  providerModelLabel: string;
  providerConnected: boolean;
  providerStatus: ConnectionStatus;
  mode: AppMode;
  theme: ThemeMode;
  onOpenProviderSettings: () => void;
  onOpenTracePanel: () => void;
  onToggleMode: () => void;
  onToggleTheme: () => void;
  characterAvatar?: string;
  characterInit?: string;
  activePresetName?: string;
  promptPresets?: Array<{ id: string; name: string }>;
  activePromptPresetId?: string | null;
  setActivePresetId?: (id: string | null) => void;
  onOpenAvatar?: () => void;
  onOpenContextMemory?: () => void;
  onToggleTweaks?: () => void;
  tweaksOpen?: boolean;
}

export function TopBar(input: TopBarProps) {
  const { t } = useT();
  const activePresetName = input.activePresetName ?? input.promptPresets?.find((p) => p.id === input.activePromptPresetId)?.name ?? t("topbar_default");
  const setAvatarOpen = input.onOpenAvatar ?? (() => { /* TODO: wire avatar panel */ });
  const setContextModalOpen = input.onOpenContextMemory ?? (() => { /* TODO: wire context memory modal */ });
  const setTweaksOpen = input.onToggleTweaks ?? (() => { /* TODO: wire tweaks panel */ });
  const tweaksOpen = input.tweaksOpen ?? false;

  const [presetDropOpen, setPresetDropOpen] = useState(false);
  const presetDropRef = useRef<HTMLDivElement>(null);
  const canSwitchPresets = !!input.promptPresets?.length && !!input.setActivePresetId;

  useEffect(() => {
    if (!presetDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetDropRef.current && !presetDropRef.current.contains(e.target as Node)) setPresetDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [presetDropOpen]);

  return (
    <div className="sticky top-0 z-50 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-border bg-surface" style={{padding:'0 22px'}}>
      <div className="flex min-w-[90px] max-w-[220px] flex-none items-center gap-2.5">
        <div className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top"
          onClick={() => setAvatarOpen()}>
          {input.characterAvatar
            ? <img src={input.characterAvatar} alt={input.characterName}/>
            : initials(input.characterName)}
        </div>
        <div className="min-w-0 overflow-hidden">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{input.characterName}</div>
          <div className="mt-px max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">{input.characterSubtitle}</div>
        </div>
      </div>

      <div className="flex min-w-0 shrink items-center gap-[5px] flex-1 overflow-visible">
        {input.mode === 'play' && (
          <MemBadge label={t("topbar_memory")} onClick={() => setContextModalOpen()} />
        )}

        <div className="flex min-h-8 min-w-0 max-w-[min(520px,60vw)] flex-[0_1_auto] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-transparent bg-transparent px-2 font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-t2 transition-colors duration-150 hover:border-border hover:bg-s2 hover:text-t1"
          style={{padding:'3px 8px'}}
          onClick={input.onOpenProviderSettings}
          title={t("provider_settings_title")}>
          <div className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
            input.providerStatus === "error" ? "bg-danger" : input.providerConnected ? "bg-success" : "bg-t4",
          )}/>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-t1">{input.providerLabel}</span>
          <span className="text-t3">·</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2">{input.providerModelLabel || '—'}</span>
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
          {presetDropOpen && input.promptPresets && input.setActivePresetId && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_12px_36px_rgba(0,0,0,.45)]">
              {input.promptPresets.map((preset) => (
                <div
                  key={preset.id}
                  className={cn(
                    "cursor-pointer truncate px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] transition-colors hover:bg-s2",
                    preset.id === input.activePromptPresetId ? "bg-accent-dim text-accent-t" : "text-t2"
                  )}
                  onClick={() => {
                    input.setActivePresetId?.(preset.id);
                    setPresetDropOpen(false);
                  }}
                >
                  {preset.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-2"/>

        <div className="cursor-pointer rounded-full bg-accent-dim text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-accent-t transition-colors duration-150 hover:bg-accent-hover"
          style={{padding:'4px 12px'}}
          tabIndex={0}
          onClick={input.onToggleMode}>
          {input.mode === 'play' ? t("topbar_build_mode") : t("topbar_play_mode")}
        </div>

        <div className={cn("flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1", tweaksOpen && "bg-accent-dim text-accent-t")}
          tabIndex={0}
          title={t("topbar_interface_settings")}
          onClick={() => setTweaksOpen()}>
          <Icons.Settings />
        </div>
      </div>
    </div>
  );
}
