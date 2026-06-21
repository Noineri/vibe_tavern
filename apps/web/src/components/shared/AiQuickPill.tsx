/**
 * AiQuickPill — inline pill with two click zones: generate (star) and settings (gear).
 *
 * [ ✨ | ⚙️ ]
 *
 * Star triggers onGenerate immediately with current persisted settings.
 * Gear opens AiQuickSettingsModal (provider/model + mode-specific options).
 */

import { useState } from "react";
import { Ic } from "./icons.js";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";
import { AiAssistantModal } from "./AiAssistantModal.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface AiQuickPillProps {
  /** Whether the generate action is currently allowed. */
  disabled?: boolean;
  /** Whether generation is in progress. */
  loading?: boolean;
  /** Star click — triggers generation immediately. */
  onGenerate: () => void;
  /** Called when user clicks the pill during loading to cancel. */
  onCancel?: () => void;
  /** Called when provider/model or mode-specific settings change. */
  onSettingsChange?: (settings: AiQuickSettings) => void;
  /** Current settings (controlled by parent). */
  settings: AiQuickSettings;
  /** Whether to show Replace/Append toggle (for lore_keys). */
  showAppendToggle?: boolean;
  /** Whether to show the key-target dropdown primary/secondary/both (for lore_keys). */
  showKeyTarget?: boolean;
  /** Whether to show recentMessageCount input (for chat_impersonate). */
  showMessageCount?: boolean;
  /** Tooltip for the star button. */
  starTooltip?: string;
  /** Tooltip for the gear button. */
  gearTooltip?: string;
  /** Size variant: "sm" matches persona pill (24px), "md" matches lorebook key input (38px), "lg" matches mobile toolbar (36px). */
  size?: "sm" | "md" | "lg";
}

export interface AiQuickSettings {
  providerId: string;
  modelName: string;
  /** lore_keys: replace vs append mode. */
  appendMode?: boolean;
  /** lore_keys: which key set to generate. Default "both". */
  keyTarget?: "primary" | "secondary" | "both";
  /** chat_impersonate: how many recent messages to send. */
  recentMessageCount?: number;
}

// ── Pill component ─────────────────────────────────────────────────────

export function AiQuickPill({
  disabled = false,
  loading = false,
  onGenerate,
  onCancel,
  onSettingsChange,
  settings,
  showAppendToggle,
  showKeyTarget,
  showMessageCount,
  starTooltip,
  gearTooltip,
  size = "sm",
}: AiQuickPillProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // sm=24px (desktop chat), lg=36px (mobile toolbar h-9), md=38px (lorebook key input)
  const heightClass = size === "md" ? "h-[38px]" : size === "lg" ? "h-9" : "h-6";
  const pxClass = size === "md" ? "px-[10px]" : size === "lg" ? "px-[11px]" : "px-[7px]";

  return (
    <>
      <div
        className={cn(
          "inline-flex items-center overflow-hidden",
          size === "lg" ? "rounded-md bg-s3" : "rounded-full bg-accent-dim",
          heightClass,
          disabled && "opacity-40 pointer-events-none",
        )}
      >
        <CustomTooltip content={loading ? undefined : starTooltip}>
          <button
            type="button"
            className={cn(
              "group/star flex h-full items-center justify-center transition-all",
              pxClass,
              size === "lg" ? "text-t3 active:bg-s2" : "text-accent-t hover:bg-accent/20",
              loading && "hover:bg-danger/15 hover:text-danger-text",
            )}
            onClick={loading ? onCancel : onGenerate}
            disabled={disabled}
          >
            {loading ? (
              <>
                <span className={cn("block h-[13px] w-[13px] animate-spin rounded-full border-2 border-t-transparent group-hover/star:hidden", size === "lg" ? "border-t3" : "border-accent-t")} />
                <span className={cn("hidden group-hover/star:block")}><Ic.close /></span>
              </>
            ) : (
              <Ic.sparkles />
            )}
          </button>
        </CustomTooltip>
        <div className={cn("w-px h-3", size === "lg" ? "bg-border" : "bg-accent/20")} />
        <CustomTooltip content={gearTooltip}>
          <button
            type="button"
            className={cn(
              "flex h-full items-center justify-center transition-all",
              pxClass,
              size === "lg" ? "text-t3 active:bg-s2" : "text-accent-t/70 hover:bg-accent/20 hover:text-accent-t",
            )}
            onClick={() => setSettingsOpen(true)}
            disabled={disabled}
          >
            <Ic.settings />
          </button>
        </CustomTooltip>
      </div>
      <AiAssistantModal
        mode="quickpill"
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={(s) => {
          onSettingsChange?.(s);
        }}
        showAppendToggle={showAppendToggle}
        showKeyTarget={showKeyTarget}
        showMessageCount={showMessageCount}
      />
    </>
  );
}
