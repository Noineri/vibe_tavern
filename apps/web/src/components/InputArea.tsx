import { useEffect, useRef, useState } from "react";
import type { InputAreaProps } from "./play-mode-types.js";
import { PersonaQuickSwitch } from "./PersonaQuickSwitch.js";
import { cn } from "../lib/cn.js";

function bucketTokens(accounting: Record<string, number>): {
  system: number;
  character: number;
  lore: number;
  summary: number;
  history: number;
} {
  let system = 0;
  let character = 0;
  let lore = 0;
  let summary = 0;
  let history = 0;

  for (const [key, value] of Object.entries(accounting)) {
    if (key === "system_preset" || key === "character_system_prompt") system += value;
    else if (key === "character" || key === "character_base") character += value;
    else if (key.startsWith("lore_entry") || key.startsWith("lore_") || key.startsWith("retrieval_memory") || key.startsWith("retrieval_")) lore += value;
    else if (key.startsWith("summary_memory") || key.startsWith("summary_")) summary += value;
    else if (key === "chat_history" || key === "recent_history") history += value;
  }

  return { system, character, lore, summary, history };
}

export function InputArea(input: InputAreaProps) {
  const [tokenPopOpen, setTokenPopOpen] = useState(false);
  const tokenPopRef = useRef<HTMLDivElement>(null);

  const buckets = bucketTokens(input.tokenAccounting);
  const inputTokens = Math.ceil(input.draft.trim().length / 4);
  const totalUsed = buckets.system + buckets.character + buckets.lore + buckets.summary + buckets.history + inputTokens;
  const tokenState = totalUsed > 12000 ? "warn" : totalUsed > 6000 ? "mid" : "ok";

  // Close popover on outside click
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

  const sendButtonText = input.isSending ? "Sending..." : input.canSend || !input.draft.trim() ? "Send" : "Unavailable";
  const statusText = input.notice || (!input.canSend ? input.sendLabel : "");

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-surface transition-opacity duration-200" style={{padding:'10px 16px 14px', opacity: input.canSend || input.isSending ? 1 : 0.82}}>
      <div className="rounded-lg border border-border bg-bg transition-colors duration-150 focus-within:border-border2">
        <textarea
          className="max-h-40 min-h-[55px] w-full resize-none border-0 bg-transparent font-body text-[16.5px] leading-[1.65] text-t1 outline-none placeholder:text-t4"
          style={{padding:'13px 16px 8px'}}
          placeholder="Continue the story..."
          value={input.draft}
          onChange={e => input.onDraftChange(e.target.value)}
          onKeyDown={e => { if (e.key==='Enter' && !e.shiftKey && input.canSend) { e.preventDefault(); input.onSend(); } }}
          rows={2}
        />
        {statusText && (
          <div
            className="max-w-[calc(100%-20px)] m-[0_10px_2px] rounded bg-s2 border border-border text-[11px] text-t3 whitespace-nowrap overflow-hidden text-ellipsis"
            style={{padding:'5px 8px'}}
            title={statusText}
          >
            {statusText}
          </div>
        )}
        <div className="flex items-center gap-[7px]" style={{padding:'6px 12px 9px'}}>
          {/* TODO: VP-W4+ — multi-persona speaker row */}
          <PersonaQuickSwitch personas={input.personas} activePersonaId={input.activePersonaId} onSelect={input.onSetPersona} />
          <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border"/>
          <div className="relative" ref={tokenPopRef}>
            <span
              className={cn("cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1", tokenState === 'warn' ? 'text-danger-text' : tokenState === 'mid' ? 'text-warning-text' : 'text-t3')}
              onClick={() => setTokenPopOpen(o => !o)}
            >
              {totalUsed.toLocaleString()}
            </span>
            {tokenPopOpen && (
              <div className="absolute bottom-[calc(100%+8px)] left-1/2 z-[220] w-[220px] -translate-x-1/2 rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)]" style={{padding:'10px 14px'}}>
                <div className="text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.08em] text-t3 font-medium border-b border-border mb-1.5" style={{paddingBottom:'6px'}}>Context Breakdown</div>
                <div className="flex justify-between text-xs text-t2 mb-1"><span>System</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{buckets.system.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs text-t2 mb-1"><span>Character</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{buckets.character.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs text-t2 mb-1"><span>Lore (RAG)</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{buckets.lore.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs text-t2 mb-1"><span>Summary</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{buckets.summary.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs text-t2 mb-1"><span>History</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{buckets.history.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs text-t2 mb-1.5"><span>Current Input</span> <span className="text-t1" style={{fontVariantNumeric:'tabular-nums'}}>{inputTokens.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs font-medium text-t1 border-t border-border mt-0.5" style={{paddingTop:'6px'}}><span>Total Used</span> <span style={{fontVariantNumeric:'tabular-nums'}}>{totalUsed.toLocaleString()}</span></div>
              </div>
            )}
          </div>
          {/* TODO: VP-W4+ — preparing/waiting/aborting/no-key/no-model send states */}
          <div className="ml-auto flex items-center gap-[5px]">
            {input.isSending ? (
              <button
                className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
                style={{padding:'0 14px'}}
                onClick={input.onCancel}
              >
                Cancel
              </button>
            ) : (
              <button
                className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all duration-150 hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:filter-none"
                style={{padding:'0 16px'}}
                disabled={!input.canSend}
                onClick={input.onSend}
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
