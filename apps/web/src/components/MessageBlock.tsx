import type { ChangeEvent } from "react";
import { Markdown } from "../lib/markdown.js";
import { initials } from "./app-shell-helpers.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";

export function MessageBlock(input: MessageBlockProps) {
  const isUser = input.message.role === "user";
  const variants = Array.isArray(input.message.variants) ? input.message.variants : [];
  const variantCount = variants.length;
  const selectedVariantIndex = input.message.selectedVariantIndex ?? 0;
  const isGenerating = Boolean(input.isGenerating);

  return (
    <>
      {input.showSeparator && (
        <div className="msg-sep">
          <div className="msg-sep-l" />
        </div>
      )}
      <article className="msg-wrap">
        <div className="msg-block">
          <div className={`msg-lbl${isUser ? "" : " char-lbl"}`}>
            <span className="msg-mini-ava">{isUser ? "Y" : initials(input.characterName)}</span>
            <span>{isUser ? "You" : input.characterName}</span>
            {!isUser && variantCount > 1 && (
              <span className="swipe-ctrl">
                <button
                  className="sw-btn"
                  disabled={input.isBusy || selectedVariantIndex <= 0}
                  onClick={input.onSelectPreviousVariant}
                >
                  <Icons.Caret direction="l" />
                </button>
                <span className="sw-n">{selectedVariantIndex + 1}/{variantCount}</span>
                <button
                  className="sw-btn"
                  disabled={input.isBusy || selectedVariantIndex >= variantCount - 1}
                  onClick={input.onSelectNextVariant}
                >
                  <Icons.Caret direction="r" />
                </button>
              </span>
            )}
          </div>

          {input.isEditing ? (
            <>
              <textarea
                className="edit-ta"
                value={input.editingDraft}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  input.onEditingDraftChange(event.target.value)
                }
              />
              <div className="edit-acts">
                <button className="edit-btn sv" disabled={input.isBusy} onClick={input.onSaveEdit}>
                  Save
                </button>
                <button className="edit-btn cn" disabled={input.isBusy} onClick={input.onCancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : isUser ? (
            <div className="user-wrap">
              <Markdown className="msg-body" text={input.message.content} />
            </div>
          ) : isGenerating ? (
            <div className="msg-body">
              <span className="gen-cur" aria-label="Generating response">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : (
            <Markdown className="msg-body" text={input.message.content} />
          )}

          {!input.isEditing && !isGenerating && (
            <div className="msg-acts">
              <button
                className="act-btn"
                disabled={input.isBusy}
                onClick={() => void navigator.clipboard?.writeText(input.message.content)}
              >
                <Icons.Copy />
                <span className="btn-label">copy</span>
              </button>
              <button className="act-btn" disabled={input.isBusy} onClick={input.onStartEdit}>
                <Icons.Edit />
                <span className="btn-label">edit</span>
              </button>
              {input.canBranch && (
                <button className="act-btn" disabled={input.isBusy} onClick={input.onBranch}>
                  <Icons.Branch />
                  <span className="btn-label">branch</span>
                </button>
              )}
              {input.canRegenerate && (
                <button className="act-btn" disabled={input.isBusy} onClick={input.onRegenerate}>
                  <Icons.Regen />
                  <span className="btn-label">regen</span>
                </button>
              )}
              <button className="act-btn act-btn-danger" disabled={input.isBusy} onClick={input.onDelete}>
                <Icons.Trash />
                <span className="btn-label">delete</span>
              </button>
            </div>
          )}
        </div>
      </article>
    </>
  );
}
