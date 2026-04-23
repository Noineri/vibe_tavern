import type { AppMode, ThemeMode } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";

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
}

export function TopBar(input: TopBarProps) {
  return (
    <header className="chat-header">
      <div className="char-info">
        <div className="char-ava">{initials(input.characterName)}</div>
        <div>
          <div className="char-name">{input.characterName}</div>
          <div className="char-sub">{input.characterSubtitle}</div>
        </div>
      </div>

      <div className="hdr-right">
        <button className="memory-badge" onClick={input.onOpenTracePanel}>
          <span className="icon-inline">
            <Icons.Trace />
          </span>
          <span className="memory-dot" />
          <span>
            {input.activatedLoreCount} lore - {input.retrievedMemoryCount} memory
          </span>
        </button>
        <button className="provider-badge" onClick={input.onOpenProviderSettings}>
          <span className={`provider-dot${input.providerConnected ? " connected" : ""}`} />
          <span className="provider-name">{input.providerLabel}</span>
          <span className="provider-divider">-</span>
          <span className="provider-model" title={input.providerModelLabel}>
            {input.providerModelLabel}
          </span>
        </button>
        <button className="mode-pill" onClick={input.onToggleMode}>
          <span className="icon-inline">
            {input.mode === "play" ? <Icons.Wrench /> : <Icons.User />}
          </span>
          {input.mode === "play" ? "Build" : "Play"}
        </button>
        <button
          className="iBtn"
          aria-label={input.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={input.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={input.onToggleTheme}
        >
          {input.theme === "dark" ? <Icons.Sun /> : <Icons.Moon />}
        </button>
      </div>
    </header>
  );
}
