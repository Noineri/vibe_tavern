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
  const copyLabel = "copy";
  const editLabel = "edit";
  const branchLabel = "branch";
  const regenLabel = "regen";
  const deleteLabel = "delete";
  const createdLabel = formatMessageTime(input.message.createdAt);
  const updatedLabel = input.message.updatedAt !== input.message.createdAt ? "edited" : null;
  const stateLabel = input.message.state !== "complete" ? input.message.state : null;
  const variantLabel = !isUser && variantCount > 1 ? `swipe ${selectedVariantIndex + 1}/${variantCount}` : null;

  return (
    <div className="msg-wrap">
      <div className="msg-block">
        <div className={`msg-lbl${isUser ? "" : " char-lbl"}`}>
          <span className="msg-mini-ava">
            {isUser ? "Y" : initials(input.characterName)}
          </span>
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
        ) : isGenerating && !input.message.content?.trim() ? (
          <div className="msg-body">
            <span className="gen-cur" aria-label="Generating response">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : (
          <>
            <Markdown className="msg-body" text={input.message.content} />
            {isGenerating && (
              <span className="gen-cur" aria-label="Generating response">
                <span />
                <span />
                <span />
              </span>
            )}
          </>
        )}

        {!input.isEditing && !isGenerating && (
          <div
            className="msg-meta message-meta"
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6, fontSize: 10.5, color: "var(--t3)", fontFamily: "var(--font-ui)" }}
          >
            {createdLabel && <span style={metaChipStyle}>{createdLabel}</span>}
            {updatedLabel && <span style={metaChipStyle}>{updatedLabel}</span>}
            {stateLabel && <span style={metaChipStyle}>{stateLabel}</span>}
            {variantLabel && <span style={metaChipStyle}>{variantLabel}</span>}
          </div>
        )}

        {!input.isEditing && !isGenerating && (
          <div className="msg-acts">
            <button
              className="act-btn"
              disabled={input.isBusy}
              onClick={() => void navigator.clipboard?.writeText(input.message.content)}
              title={copyLabel}
              aria-label={copyLabel}
            >
              <Icons.Copy />
              {copyLabel}
            </button>
            <button
              className="act-btn"
              disabled={input.isBusy}
              onClick={input.onStartEdit}
              title={editLabel}
              aria-label={editLabel}
            >
              <Icons.Edit />
              {editLabel}
            </button>
            {input.canBranch && (
              <button
                className="act-btn"
                disabled={input.isBusy}
                onClick={input.onBranch}
                title={branchLabel}
                aria-label={branchLabel}
              >
                <Icons.Branch />
                {branchLabel}
              </button>
            )}
            {input.canRegenerate && (
              <button
                className="act-btn"
                disabled={input.isBusy}
                onClick={input.onRegenerate}
                title={regenLabel}
                aria-label={regenLabel}
              >
                <Icons.Regen />
                {regenLabel}
              </button>
            )}
            <button
              className="act-btn"
              style={{ marginLeft: "auto" }}
              disabled={input.isBusy}
              onClick={input.onDelete}
              title={deleteLabel}
              aria-label={deleteLabel}
            >
              <Icons.Trash />
              {deleteLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const metaChipStyle = {
  background: "var(--s2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "2px 6px",
};

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
