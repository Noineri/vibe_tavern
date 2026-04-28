import type { ChangeEvent, KeyboardEvent } from "react";
import type { InputAreaProps } from "./play-mode-types.js";
import { PersonaQuickSwitch } from "./PersonaQuickSwitch.js";

export function InputArea(input: InputAreaProps) {
  const sendButtonText = input.isSending ? "Sending..." : input.canSend || !input.draft.trim() ? "Send" : "Unavailable";
  const statusText = input.notice || (!input.canSend ? input.sendLabel : "");
  const tokenState = input.tokenCount > 12000 ? "warn" : input.tokenCount > 6000 ? "mid" : "ok";
  const tokenColor = tokenState === "warn" ? "oklch(0.72 0.14 70)" : tokenState === "mid" ? "var(--accent-t)" : "oklch(0.68 0.16 145)";

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
          <span className="tok-c" title={input.notice || input.sendLabel} style={{ color: tokenColor }}>
            {input.tokenCount.toLocaleString()}
          </span>
          <div className="input-r">
            <button
              className="send-btn"
              style={input.isSending ? { background: "var(--s3)", color: "var(--t2)" } : undefined}
              disabled={!input.canSend}
              onClick={input.onSend}
              aria-label={input.sendLabel}
              title={input.sendLabel}
            >
              {sendButtonText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
