import { memo } from "react";
import { MessageBlock } from "../chat/MessageBlock.js";
import type { MessageBlockProps } from "../play/play-mode-types.js";
import { useDisplayMessage, useMessageAuthor } from "../../stores/chat-selectors.js";
import { useT } from "../../i18n/context.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import type { MessageShellAuthorInfo } from "../chat/MessageShell.js";
import { Icons } from "../shared/icons.js";

/**
 * Co-author message block wrapper.
 * Delegates actual rendering to the shared `MessageBlock`, but overrides
 * the author identity (CS-30) and disables macro resolution (CS-26).
 */
export const CoauthorMessageBlock = memo(function CoauthorMessageBlock(props: MessageBlockProps) {
  const { t } = useT();
  const msg = useDisplayMessage(props.messageId);
  const authorInfo = useMessageAuthor();

  if (!msg || !authorInfo) return null;

  const isUser = msg.role === "user";

  const authorOverride: MessageShellAuthorInfo = isUser
    ? {
        name: t("coauthor_author_you"),
        avatarAssetId: null,
        avatarCropJson: null,
        avatarSrc: null,
        avatarNode: <Icons.User className="h-5 w-5 opacity-70" />,
      }
    : {
        name: `${t("coauthor_author_assistant")}: ${authorInfo.character.name}`,
        avatarAssetId: authorInfo.character.avatarAssetId,
        avatarCropJson: authorInfo.character.avatarCropJson,
        avatarSrc: resolveEntityAvatarUrl({
          kind: "characters",
          id: authorInfo.character.id,
          avatarExt: authorInfo.character.avatarExt,
          avatarAssetId: authorInfo.character.avatarAssetId,
          updatedAt: authorInfo.character.updatedAt,
        }),
        avatarNode: (
          <div className="flex h-full w-full items-center justify-center bg-s3">
            <Icons.Sparkles className="h-5 w-5 text-t3" />
          </div>
        ),
        nameNode: (
          <span className="flex items-center gap-1.5">
            <span className="text-t3">{t("coauthor_author_assistant")}:</span>
            <span className="flex items-center gap-1.5 font-medium text-accent-t">
              <div className="h-5 w-5 overflow-hidden rounded-full bg-s3">
                {authorInfo.character.avatarAssetId ? (
                  <img
                    src={resolveEntityAvatarUrl({
                      kind: "characters",
                      id: authorInfo.character.id,
                      avatarExt: authorInfo.character.avatarExt,
                      avatarAssetId: authorInfo.character.avatarAssetId,
                      updatedAt: authorInfo.character.updatedAt,
                    })!}
                    alt={authorInfo.character.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-s3 text-[10px] font-medium text-t3">
                    {authorInfo.character.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              {authorInfo.character.name}
            </span>
          </span>
        ),
      };

  return <MessageBlock {...props} authorOverride={authorOverride} />;
});
