import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import type { InputAreaProps } from "./play-mode-types.js";
import { PersonaQuickSwitch } from "./PersonaQuickSwitch.js";

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
    <div className="input-area">
      <div className="input-box" style={input.canSend || input.isSending ? undefined : { opacity: 0.82 }}>
        <textarea
          className="input-ta"
          value={input.draft}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            input.onDraftChange(event.target.value)
          }
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey && input.canSend) {
              event.preventDefault();
              input.onSend();
            }
          }}
          placeholder="Continue the story..."
          rows={2}
        />
        {statusText && (
          <div
            title={statusText}
            style={{
              display: "inline-flex",
              maxWidth: "calc(100% - 20px)",
              margin: "0 10px 2px",
              padding: "5px 8px",
              borderRadius: 5,
              background: "var(--s2)",
              border: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--t3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {statusText}
          </div>
        )}
        <div className="input-row">
          <PersonaQuickSwitch personas={input.personas} activePersonaId={input.activePersonaId} onSelect={input.onSetPersona} />
          <div className="sep-v" />
          <div ref={tokenPopRef}>
            <span
              className={`tok-c ${tokenState}`}
              onClick={() => setTokenPopOpen((o) => !o)}
            >
              {totalUsed.toLocaleString()}
            </span>
            {tokenPopOpen && (
              <div className="mem-pop input-pop center">
                <div className="mem-pop-ttl">Context Breakdown</div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>System</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{buckets.system.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>Character</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{buckets.character.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>Lore (RAG)</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{buckets.lore.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>Summary</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{buckets.summary.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>History</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{buckets.history.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--t2)" }}>Current Input</span>
                  <span style={{ color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>{inputTokens.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0 0", fontSize: 12, fontWeight: 500 }}>
                  <span style={{ color: "var(--t1)" }}>Total Used</span>
                  <span style={{ color: "var(--accent-t)", fontVariantNumeric: "tabular-nums" }}>{totalUsed.toLocaleString()}</span>
                </div>
              </div>
            )}
          </div>
          <div className="input-r">
            {input.isSending ? (
              <button
                className="cancel-btn"
                onClick={input.onCancel}
                title="Stop generation"
              >
                Cancel
              </button>
            ) : (
              <button
                className="send-btn"
                style={input.canSend ? undefined : { background: "var(--s3)", color: "var(--t2)" }}
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
