import { useEffect, useRef, useState } from "react";
import type { InputAreaProps } from "./play-mode-types.js";
import { PersonaQuickSwitch } from "./PersonaQuickSwitch.js";
import { cn } from "../lib/cn.js";
import { useTokenCount } from "../hooks/use-token-count.js";

function bucketTokens(accounting: Record<string, number>): {
  system: number;
  character: number;
  persona: number;
  summary: number;
  history: number;
} {
  let system = 0;
  let character = 0;
  let persona = 0;
  let summary = 0;
  let history = 0;

  for (const [key, value] of Object.entries(accounting)) {
    if (
      key === "system_preset" ||
      key === "character_system_prompt" ||
      key === "post_history" ||
      key === "authors_note" ||
      key === "prompt_preset"
    ) {
      system += value;
    } else if (key === "character" || key === "character_base" || key === "character_description" || key === "character_scenario") {
      character += value;
    } else if (key === "persona" || key === "user_persona") {
      persona += value;
    } else if (key.startsWith("summary_memory") || key.startsWith("summary_")) {
      summary += value;
    } else if (key === "chat_history" || key === "recent_history") {
      history += value;
    }
    // lore/retrieval entries are part of system layer
    else if (key.startsWith("lore_entry") || key.startsWith("lore_") || key.startsWith("retrieval_")) {
      system += value;
    }
  }

  return { system, character, persona, summary, history };
}

export function InputArea(input: InputAreaProps) {
  const [tokenPopOpen, setTokenPopOpen] = useState(false);
  const tokenPopRef = useRef<HTMLDivElement>(null);

  const buckets = bucketTokens(input.tokenAccounting);
  const inputTokens = useTokenCount(input.draft);
  const totalUsed = buckets.system + buckets.character + buckets.persona + buckets.summary + buckets.history + inputTokens;
  const contextSize = input.contextSize;
  const maxTokens = input.maxTokens;
  const availableBudget = Math.max(0, contextSize - maxTokens);
  const usageRatio = availableBudget > 0 ? totalUsed / availableBudget : 0;
  const tokenState = usageRatio > 0.95 ? "warn" : usageRatio > 0.75 ? "mid" : "ok";

  useEffect(() => {
    if (!tokenPopOpen) return;
    function handleClick(e: MouseEvent) {
      if (tokenPopRef.current && !tokenPopRef.current.contains(e.target as Node)) {
        setTokenPopOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [tokenPopOpen]);

  const sendButtonText = input.canSend || !input.draft.trim() ? "Send" : input.sendLabel || "Unavailable";

  return (
    <div
      className="relative z-10 shrink-0 border-t border-border bg-surface transition-opacity duration-200"
      style={{ padding: "10px 16px 14px", opacity: input.canSend || input.isSending || input.draft.trim() ? 1 : 0.82 }}
    >
      <div className="rounded-lg border border-border bg-bg transition-colors duration-150 focus-within:border-border2">
        <textarea
          className="max-h-40 min-h-[55px] w-full resize-none border-0 bg-transparent font-body text-[16.5px] leading-[1.65] text-t1 outline-none placeholder:text-t4"
          style={{ padding: "13px 16px 8px" }}
          placeholder="Continue the story..."
          value={input.draft}
          onChange={(event) => input.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (input.canSend) input.onSend();
            }
          }}
          rows={2}
        />

        <div className="relative flex items-center gap-[7px]" style={{ padding: "6px 92px 9px 12px" }}>
          <div className="speaker-row multi-persona" title="multi-persona">
            <span className="text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.06em] text-t3">Speak as</span>
          </div>
          <PersonaQuickSwitch personas={input.personas} activePersonaId={input.activePersonaId} onSelect={input.onSetPersona} />
          <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />

          <div className="relative" ref={tokenPopRef}>
            <span
              className={cn(
                "cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1",
                tokenState === "warn" ? "text-danger-text" : tokenState === "mid" ? "text-warning-text" : "text-t3",
              )}
              onClick={() => setTokenPopOpen((open) => !open)}
            >
              {totalUsed.toLocaleString()} / {contextSize > 0 ? contextSize.toLocaleString() : "∞"}
            </span>
            {tokenPopOpen && (
              <div
                className="absolute bottom-[calc(100%+8px)] left-1/2 z-[220] w-[220px] -translate-x-1/2 rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
                style={{ padding: "10px 14px" }}
              >
                <div className="mb-1.5 border-b border-border text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ paddingBottom: "6px" }}>Context Breakdown</div>
                <div className="mb-1 flex justify-between text-xs text-t2"><span>System</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{buckets.system.toLocaleString()}</span></div>
                <div className="mb-1 flex justify-between text-xs text-t2"><span>Character</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{buckets.character.toLocaleString()}</span></div>
                <div className="mb-1 flex justify-between text-xs text-t2"><span>Persona</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{buckets.persona.toLocaleString()}</span></div>
                <div className="mb-1 flex justify-between text-xs text-t2"><span>Summary</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{buckets.summary.toLocaleString()}</span></div>
                <div className="mb-1 flex justify-between text-xs text-t2"><span>History</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{buckets.history.toLocaleString()}</span></div>
                <div className="mb-1.5 flex justify-between text-xs text-t2"><span>Current Input</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>{inputTokens.toLocaleString()}</span></div>
                <div className="mb-1 flex justify-between border-t border-border text-xs text-t2" style={{ paddingTop: "6px" }}><span>Response Budget</span><span className="text-t1" style={{ fontVariantNumeric: "tabular-nums" }}>-{maxTokens.toLocaleString()}</span></div>
                <div className="mt-0.5 flex justify-between text-xs font-medium text-t1"><span>Total Available</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{availableBudget.toLocaleString()}</span></div>
              </div>
            )}
          </div>

          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-[5px]">
            {input.isSending ? (
              <button
                className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
                style={{ padding: "0 14px" }}
                onClick={input.onCancel}
              >
                Cancel
              </button>
            ) : (
              <button
                className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all duration-150 hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:filter-none"
                style={{ padding: "0 16px", background: "var(--accent)", color: "var(--on-accent)", borderRadius: 5 }}
                disabled={!input.canSend}
                onClick={input.onSend}
                aria-label={input.sendLabel}
                title={input.sendLabel}
              >
                {sendButtonText}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
