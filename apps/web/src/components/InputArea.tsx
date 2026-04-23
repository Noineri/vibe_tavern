import type { ChangeEvent, KeyboardEvent } from "react";
import type { InputAreaProps } from "./play-mode-types.js";

export function InputArea(input: InputAreaProps) {
  const sendButtonText = input.isSending ? "Sending..." : "Send";

  return (
    <section className="input-area">
      <div className="input-box">
        <textarea
          className="input-ta"
          value={input.draft}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => input.onDraftChange(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey && input.canSend) {
              event.preventDefault();
              input.onSend();
            }
          }}
          placeholder="Continue the story..."
          rows={2}
        />
        <div className="input-row">
          <span className="char-pill" title={input.personaName || input.characterName}>
            {input.personaName || input.characterName}
          </span>
          <div className="sep-v" />
          <span className="tok-c" title={input.notice || input.sendLabel}>
            {input.tokenCount} tokens
          </span>
          <div className="input-r">
            <button
              className="send-btn"
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
    </section>
  );
}
