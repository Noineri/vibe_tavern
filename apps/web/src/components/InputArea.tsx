import type { ChangeEvent, KeyboardEvent } from "react";
import type { InputAreaProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";

export function InputArea(input: InputAreaProps) {
  return (
    <section className="input-area">
      <div className="composer-box">
        <div className="input-box">
          <textarea
            className="input-ta"
            value={input.draft}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => input.onDraftChange(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey && !input.isSending) {
                event.preventDefault();
                input.onSend();
              }
            }}
            placeholder="Continue the story..."
          />
          <div className="input-row">
            <span className="char-pill">{input.characterName}</span>
            <div className="sep-v" />
            <span className="tok-c">tokens {input.tokenCount}</span>
            <div className="input-r">
              <button
                className="send-btn"
                disabled={input.isSending}
                onClick={input.onSend}
                aria-label={input.sendLabel}
                title={input.sendLabel}
              >
                <Icons.Send />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
