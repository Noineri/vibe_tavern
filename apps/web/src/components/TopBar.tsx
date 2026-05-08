import type { AppMode, ThemeMode } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";

interface TopBarProps {
  characterName: string;
  characterSubtitle: string;
  activatedLoreCount: number;
  retrievedMemoryCount: number;
  providerLabel: string;
  providerModelLabel: string;
  providerConnected: boolean;
  mode: AppMode;
  theme: ThemeMode;
  onOpenProviderSettings: () => void;
  onOpenTracePanel: () => void;
  onToggleMode: () => void;
  onToggleTheme: () => void;
  characterAvatar?: string;
  characterInit?: string;
  activePresetName?: string;
  onOpenAvatar?: () => void;
  onOpenContextMemory?: () => void;
  onToggleTweaks?: () => void;
  tweaksOpen?: boolean;
}

export function TopBar(input: TopBarProps) {
  const t = (key: string) => key;
  const activePresetName = input.activePresetName ?? 'Default';
  const setAvatarOpen = input.onOpenAvatar ?? (() => { /* TODO: wire avatar panel */ });
  const setContextModalOpen = input.onOpenContextMemory ?? (() => { /* TODO: wire context memory modal */ });
  const setTweaksOpen = input.onToggleTweaks ?? (() => { /* TODO: wire tweaks panel */ });
  const tweaksOpen = input.tweaksOpen ?? false;

  return (
    <div className="sticky top-0 z-50 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-border bg-surface" style={{padding:'0 22px'}}>
      <div className="flex min-w-[90px] max-w-[220px] flex-none items-center gap-2.5">
        <div className="flex h-[37px] w-[37px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)-1px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top"
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
          <div className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-s2 px-3 py-1 text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors duration-150 hover:border-accent hover:text-accent-t"
            onClick={() => setContextModalOpen()}
            title={t("scenario_memory")}>
            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"/>
            <span>{t("scenario_memory")}</span>
          </div>
        )}

        <div className="flex min-h-8 min-w-0 max-w-[min(520px,60vw)] flex-[0_1_auto] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-transparent bg-transparent px-2 font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-t2 transition-colors duration-150 hover:border-border hover:bg-s2 hover:text-t1"
          style={{padding:'3px 8px'}}
          onClick={input.onOpenProviderSettings}
          title={t("provider_settings_tooltip")}>
          <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300", input.providerConnected ? "bg-success" : "bg-t4")}/>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-t1">{input.providerLabel}</span>
          <span className="text-t3">·</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2">{input.providerModelLabel || '—'}</span>
          <span className="text-border2">|</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-accent-t font-medium text-[calc(var(--ui-fs)-4px)] uppercase leading-tight">{activePresetName}</span>
          <Icons.Caret direction="d" />
        </div>

        <div className="flex-1 min-w-2"/>

        <div className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-accent-t transition-colors duration-150 hover:bg-accent-hover"
          tabIndex={0}
          onClick={input.onToggleMode}>
          {input.mode === 'play' ? t("build") : t("play")}
        </div>

        <div className={cn("flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1", tweaksOpen && "bg-accent-dim text-accent-t")}
          tabIndex={0}
          title={t("interface_settings_tooltip")}
          onClick={() => setTweaksOpen()}>
          <Icons.Settings />
        </div>
      </div>
    </div>
  );
}
