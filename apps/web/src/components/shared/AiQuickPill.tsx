/**
 * AiQuickPill — inline pill with two click zones: generate (star) and settings (gear).
 *
 * [ ✨ | ⚙️ ]
 *
 * Star triggers onGenerate immediately with current persisted settings.
 * Gear opens AiQuickSettingsModal (provider/model + mode-specific options).
 */

import { useEffect, useState } from "react";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { fetchProviderModelsAction } from "../../stores/api-actions/provider-actions.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import type { ProviderProfileRecord } from "../../app-client.js";
import { Ic } from "./icons.js";
import { cn } from "../../lib/cn.js";
import { DropdownSelect } from "./DropdownSelect.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface AiQuickPillProps {
  /** Whether the generate action is currently allowed. */
  disabled?: boolean;
  /** Whether generation is in progress. */
  loading?: boolean;
  /** Star click — triggers generation immediately. */
  onGenerate: () => void;
  /** Called when provider/model or mode-specific settings change. */
  onSettingsChange?: (settings: AiQuickSettings) => void;
  /** Current settings (controlled by parent). */
  settings: AiQuickSettings;
  /** Whether to show Replace/Append toggle (for lore_keys). */
  showAppendToggle?: boolean;
  /** Whether to show recentMessageCount input (for chat_impersonate). */
  showMessageCount?: boolean;
  /** Tooltip for the star button. */
  starTooltip?: string;
  /** Tooltip for the gear button. */
  gearTooltip?: string;
}

export interface AiQuickSettings {
  providerId: string;
  modelName: string;
  /** lore_keys: replace vs append mode. */
  appendMode?: boolean;
  /** chat_impersonate: how many recent messages to send. */
  recentMessageCount?: number;
}

// ── Settings modal ─────────────────────────────────────────────────────

function AiQuickSettingsModal({
  open,
  onClose,
  settings,
  onSettingsChange,
  showAppendToggle,
  showMessageCount,
}: {
  open: boolean;
  onClose: () => void;
  settings: AiQuickSettings;
  onSettingsChange: (s: AiQuickSettings) => void;
  showAppendToggle?: boolean;
  showMessageCount?: boolean;
}) {
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const [providerId, setProviderId] = useState(settings.providerId);
  const [modelName, setModelName] = useState(settings.modelName);
  const [appendMode, setAppendMode] = useState(settings.appendMode ?? false);
  const [recentMessageCount, setRecentMessageCount] = useState(settings.recentMessageCount ?? 20);
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label?: string }>>([]);

  const selectedProfile = providerProfiles.find((p) => p.id === providerId);

  // Sync from controlled settings when opening; fall back to persisted uiSettings.
  useEffect(() => {
    if (!open) return;
    setProviderId(settings.providerId || bootstrapUiSettings?.aiAssistantProviderId || "");
    setModelName(settings.modelName || bootstrapUiSettings?.aiAssistantModelName || "");
    setAppendMode(settings.appendMode ?? false);
    setRecentMessageCount(settings.recentMessageCount ?? 20);
  }, [open, settings.providerId, settings.modelName, settings.appendMode, settings.recentMessageCount, bootstrapUiSettings]);

  useEffect(() => {
    if (!providerId) { setProviderModels([]); return; }
    let cancelled = false;
    void fetchProviderModelsAction(providerId).then((response: unknown) => {
      if (!cancelled) {
        const models = (response && typeof response === "object" && "models" in response ? (response as { models: Array<{ id: string; label?: string }> }).models : []) as Array<{ id: string; label?: string }>;
        setProviderModels(models);
      }
    });
    return () => { cancelled = true; };
  }, [providerId]);

  if (!open) return null;

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    setModelName("");
  };

  const handleApply = () => {
    const updated: AiQuickSettings = {
      providerId,
      modelName,
      appendMode,
      recentMessageCount,
    };
    onSettingsChange(updated);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex w-[380px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border" style={{ padding: "14px 18px" }}>
          <span className="text-sm font-semibold text-t1">AI Settings</span>
          <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
            <Ic.close />
          </div>
        </div>
        <div className="flex flex-col gap-3" style={{ padding: "16px 18px" }}>
          {providerProfiles.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-t3">No providers configured. Add one in Settings.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.05em] text-t3">Provider</label>
                  <DropdownSelect
                    value={providerId}
                    options={providerProfiles.map((p: ProviderProfileRecord) => ({ id: p.id, label: p.name }))}
                    placeholder="Select..."
                    onChange={handleProviderChange}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.05em] text-t3">Model</label>
                  <DropdownSelect
                    value={modelName}
                    options={providerModels.map((m) => ({ id: m.id, label: m.label || m.id }))}
                    placeholder={selectedProfile?.defaultModel || "Default"}
                    defaultOption={selectedProfile?.defaultModel || "Default"}
                    onChange={(id) => setModelName(id)}
                    disabled={!providerId}
                  />
                </div>
              </div>
              {showAppendToggle && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-all",
                      !appendMode ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t2 hover:border-t3"
                    )}
                    onClick={() => setAppendMode(false)}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-all",
                      appendMode ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t2 hover:border-t3"
                    )}
                    onClick={() => setAppendMode(true)}
                  >
                    Append
                  </button>
                </div>
              )}
              {showMessageCount && (
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.05em] text-t3">
                    Recent messages
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={recentMessageCount}
                    onChange={(e) => setRecentMessageCount(Math.max(1, parseInt(e.target.value) || 20))}
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "10px 18px" }}>
          <button type="button" className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 text-[12px] font-medium text-on-accent transition-all hover:opacity-90" onClick={handleApply}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pill component ─────────────────────────────────────────────────────

export function AiQuickPill({
  disabled = false,
  loading = false,
  onGenerate,
  onSettingsChange,
  settings,
  showAppendToggle,
  showMessageCount,
  starTooltip,
  gearTooltip,
}: AiQuickPillProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "inline-flex items-stretch rounded-md border border-border bg-s3 overflow-hidden",
          disabled && "opacity-40 pointer-events-none",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex items-center justify-center px-1.5 py-1 transition-all",
            "hover:bg-s2 hover:text-accent-t",
            loading && "pointer-events-none",
          )}
          onClick={onGenerate}
          disabled={disabled || loading}
          title={starTooltip}
        >
          {loading ? (
            <span className="block h-[13px] w-[13px] animate-spin rounded-full border-2 border-t-transparent border-accent" />
          ) : (
            <Ic.star />
          )}
        </button>
        <div className="w-px bg-border" />
        <button
          type="button"
          className="flex items-center justify-center px-1.5 py-1 text-t3 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => setSettingsOpen(true)}
          disabled={disabled}
          title={gearTooltip}
        >
          <Ic.settings />
        </button>
      </div>
      <AiQuickSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={(s) => {
          onSettingsChange?.(s);
        }}
        showAppendToggle={showAppendToggle}
        showMessageCount={showMessageCount}
      />
    </>
  );
}
