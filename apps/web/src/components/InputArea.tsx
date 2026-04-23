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
              if (event.key === "Enter" && !event.shiftKey && input.canSend) {
                event.preventDefault();
                input.onSend();
              }
            }}
            placeholder="Continue the story..."
          />
          <div className="input-row">
            <span className="char-pill">{input.personaName || input.characterName}</span>
            <div className="sep-v" />
            <span className="tok-c">{input.tokenCount} tokens</span>
            <div className="input-r">
              <button
                className="send-btn"
                disabled={!input.canSend}
                onClick={input.onSend}
                aria-label={input.sendLabel}
                title={input.sendLabel}
              >
                <Icons.Send />
              </button>
            </div>
          </div>
        </div>
        {input.notice && <div className="composer-notice">{input.notice}</div>}
      </div>
    </section>
  );
}
