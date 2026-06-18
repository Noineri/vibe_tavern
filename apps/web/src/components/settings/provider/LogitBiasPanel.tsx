/**
 * LogitBiasPanel — Token Workbench for biasing individual tokens.
 *
 * Workflow:
 * 1. User types text in the input
 * 2. Clicks "Tokenize" → API call → tokens shown as chips
 * 3. Each token chip has a bias slider (-100 to 100)
 * 4. User can also manually add a token ID
 * 5. Toggle enables/disables the entire feature
 *
 * When provider doesn't support logit bias, shows soft-disabled state.
 */

import React, { useState, useCallback } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

// ── Types ──────────────────────────────────────────────────────────

interface LogitBiasEntry {
  tokenId: number;
  bias: number;
  text?: string;
  sourceText?: string;
  model?: string;
}

interface LogitBiasPanelProps {
  entries: LogitBiasEntry[];
  onChange: (entries: LogitBiasEntry[]) => void;
  disabled?: boolean;
  /** Whether this provider/model supports logit bias */
  supported: boolean;
  /** Model used to choose tokenizer IDs. */
  model?: string;
}

// ── Bias Row ───────────────────────────────────────────────────────

function BiasRow({
  entry,
  onUpdate,
  onRemove,
  disabled = false,
  stale = false,
}: {
  entry: LogitBiasEntry;
  onUpdate: (e: LogitBiasEntry) => void;
  onRemove: () => void;
  disabled?: boolean;
  stale?: boolean;
}) {
  const { t } = useT();
  const biasColor = entry.bias === 0
    ? "text-t3"
    : entry.bias < 0
      ? "text-danger"
      : "text-success";

  return (
    <div className={cn("group flex items-center gap-2 rounded-lg border bg-s2 px-3 py-2 transition-colors", stale ? "border-warning/50 opacity-60" : "border-border hover:border-border2")}>
      {/* Token text / ID */}
      <div className="flex shrink-0 items-center gap-1.5">
        {entry.text ? (
          <span className="inline-block max-w-[120px] truncate rounded bg-s3 px-1.5 py-0.5 font-mono text-[11px] text-t1">
            "{entry.text}"
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-t3">#{entry.tokenId}</span>
        {stale && <span className="rounded bg-warning/10 px-1 py-0.5 font-ui text-[9px] uppercase tracking-wide text-warning">{t("stale_badge")}</span>}
      </div>

      {/* Bias slider */}
      <div className="flex flex-1 items-center gap-2">
        <button
          type="button"
          disabled={disabled || stale}
          onClick={() => onUpdate({ ...entry, bias: Math.max(-100, entry.bias - 10) })}
          className="shrink-0 rounded border border-border bg-s3 px-1.5 py-0.5 text-[10px] text-t3 transition-colors hover:border-accent hover:text-accent-t disabled:pointer-events-none"
        >
          −
        </button>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={entry.bias}
          disabled={disabled || stale}
          onChange={(e) => onUpdate({ ...entry, bias: parseInt(e.target.value, 10) })}
          className="!h-[4px] flex-1 !rounded-full !border-0 accent-accent p-0 disabled:pointer-events-none"
        />
        <button
          type="button"
          disabled={disabled || stale}
          onClick={() => onUpdate({ ...entry, bias: Math.min(100, entry.bias + 10) })}
          className="shrink-0 rounded border border-border bg-s3 px-1.5 py-0.5 text-[10px] text-t3 transition-colors hover:border-accent hover:text-accent-t disabled:pointer-events-none"
        >
          +
        </button>
      </div>

      {/* Bias value */}
      <span className={cn("w-10 shrink-0 text-right font-mono text-[11px] font-medium", biasColor)}>
        {entry.bias > 0 ? "+" : ""}{entry.bias}
      </span>

      {/* Quick ban button */}
      {entry.bias !== -100 && (
        <CustomTooltip content="Ban token (-100)">
          <button
            type="button"
            disabled={disabled || stale}
            onClick={() => onUpdate({ ...entry, bias: -100 })}
            className="shrink-0 rounded border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/20 disabled:pointer-events-none"
          >
            🚫
          </button>
        </CustomTooltip>
      )}

      {/* Remove */}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-t3 transition-opacity hover:text-danger disabled:pointer-events-none"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
          <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
          <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
        </svg>
      </button>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export function LogitBiasPanel({ entries, onChange, disabled, supported, model }: LogitBiasPanelProps) {
  const { t } = useT();
  const [textInput, setTextInput] = useState("");
  const [manualId, setManualId] = useState("");
  const [loading, setLoading] = useState(false);

  const addEntries = useCallback(
    (newTokens: Array<{ id: number; text: string }>, sourceText: string, defaultBias = -100) => {
      const currentModel = model || undefined;
      const existing = new Set(entries.filter((e) => e.model === currentModel).map((e) => e.tokenId));
      const toAdd = newTokens
        .filter((tok) => !existing.has(tok.id))
        .map((tok) => ({ tokenId: tok.id, bias: defaultBias, text: tok.text, sourceText, model: currentModel }));
      if (toAdd.length > 0) onChange([...entries, ...toAdd]);
    },
    [entries, model, onChange],
  );

  const handleTokenize = useCallback(async () => {
    if (!textInput.trim()) return;
    setLoading(true);
    try {
      const resp = await fetch("/api/tokenize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: textInput, model: model || undefined }),
      });
      if (!resp.ok) throw new Error("Tokenization failed");
      const data = await resp.json() as { tokens: Array<{ id: number; text: string }> };
      addEntries(data.tokens, textInput);
      setTextInput("");
    } catch {
      // Silently fail — could add toast later
    } finally {
      setLoading(false);
    }
  }, [textInput, model, addEntries]);

  const handleManualAdd = useCallback(() => {
    const id = parseInt(manualId.trim(), 10);
    if (isNaN(id)) return;
    const currentModel = model || undefined;
    const existing = new Set(entries.filter((e) => e.model === currentModel).map((e) => e.tokenId));
    if (existing.has(id)) return;
    onChange([...entries, { tokenId: id, bias: -100, model: currentModel }]);
    setManualId("");
  }, [manualId, model, entries, onChange]);

  const updateEntry = useCallback(
    (index: number, updated: LogitBiasEntry) => {
      const next = [...entries];
      next[index] = updated;
      onChange(next);
    },
    [entries, onChange],
  );

  const removeEntry = useCallback(
    (index: number) => {
      const next = [...entries];
      next.splice(index, 1);
      onChange(next);
    },
    [entries, onChange],
  );

  // Soft-disable for unsupported providers
  if (!supported) {
    return (
      <div className="mt-4">
        <div className="mb-[7px] flex items-center gap-1.5">
          <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("logit_bias_label")}
          </label>
          <CustomTooltip content={t("logit_bias_tooltip")} side="right">
            <span className="cursor-help font-ui text-[10px] text-t3/60">?</span>
          </CustomTooltip>
        </div>
        <div className="rounded-lg border border-border bg-s2 px-3 py-4 text-center">
          <div className="font-ui text-[12px] text-t3">
            {t("logit_bias_unsupported")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("mt-4", disabled && "opacity-40")}>
      <div className="mb-[7px] flex items-center gap-1.5">
        <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
          {t("logit_bias_label")}
        </label>
        <CustomTooltip content={t("logit_bias_tooltip")} side="right">
          <span className="cursor-help font-ui text-[10px] text-t3/60">?</span>
        </CustomTooltip>
      </div>

      {/* Tokenize input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleTokenize(); }}
          placeholder={t("logit_bias_tokenize_placeholder")}
          disabled={disabled || loading}
          className="h-[38px] flex-1 rounded-md border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent placeholder:text-t3/50"
        />
        <button
          type="button"
          onClick={() => void handleTokenize()}
          disabled={disabled || loading || !textInput.trim()}
          className={cn(
            "h-[38px] shrink-0 rounded-md border px-3 font-ui text-[12px] font-medium transition-colors",
            loading || !textInput.trim()
              ? "border-border bg-s3 text-t3 cursor-not-allowed"
              : "border-accent bg-accent/10 text-accent-t hover:bg-accent/20",
          )}
        >
          {loading ? "…" : t("logit_bias_tokenize_btn")}
        </button>
      </div>

      {/* Manual token ID input */}
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleManualAdd(); }}
          placeholder={t("logit_bias_manual_placeholder")}
          disabled={disabled}
          className="h-[30px] flex-1 rounded-md border border-border bg-s2 px-3 font-mono text-[11px] text-t1 outline-none transition-colors focus:border-accent placeholder:text-t3/50"
        />
        <button
          type="button"
          onClick={handleManualAdd}
          disabled={disabled || !manualId.trim()}
          className={cn(
            "h-[30px] shrink-0 rounded-md border border-border px-2 font-ui text-[11px] text-t3 transition-colors",
            !manualId.trim() ? "cursor-not-allowed" : "hover:border-accent hover:text-accent-t",
          )}
        >
          +
        </button>
      </div>

      {/* Token entries */}
      {entries.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {entries.map((entry, i) => {
            const stale = Boolean(model && entry.model !== model);
            return (
              <BiasRow
                key={`${entry.model ?? "legacy"}:${entry.tokenId}`}
                entry={entry}
                onUpdate={(e) => updateEntry(i, e)}
                onRemove={() => removeEntry(i)}
                disabled={disabled}
                stale={stale}
              />
            );
          })}
        </div>
      )}

      {entries.length === 0 && (
        <div className="mt-2 font-ui text-[11px] text-t3/60">
          {t("logit_bias_empty_hint")}
        </div>
      )}
    </div>
  );
}
