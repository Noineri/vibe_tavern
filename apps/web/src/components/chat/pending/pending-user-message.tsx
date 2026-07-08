import { useRef } from "react";
import { useChatMeta, useMacroContext } from "../../../stores/chat-selectors.js";
import { useActiveGeneration } from "../../../stores/index.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { resolveEntityAvatarUrl } from "../../../lib/avatar.js";
import { replaceUiMacros } from "../../../lib/macros.js";
import { Markdown } from "../../../lib/markdown.js";
import { MessageShell } from "../MessageShell.js";
import { AttachmentGrid } from "../AttachmentGrid.js";

/**
 * Pending-user singleton: renders the user's just-sent message as a busy
 * placeholder while the request is in flight (before the server persists it).
 * One instance per active generation (rendered by MessageBlock's main body on
 * the `__pending-user` early-return path).
 *
 * This is one of the two broad-selector consumers the message-block isolation
 * test explicitly ALLOWED in MessageBlock.tsx (useChatMeta / useActiveGeneration
 * — fine for a singleton, would leak across every message if called from the
 * memoized main body). Extracted verbatim into its own file in god-object audit
 * step 3; the broad-selector usage moved with it.
 */
export function PendingUserMessage() {
  const chatMeta = useChatMeta();
  const activeGen = useActiveGeneration();
  const isMobile = useIsMobile();
  const macroContext = useMacroContext();
  const isCoauthorMode = useSnapshotStore(s => s.activeChat?.mode === "coauthor");
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  if (!chatMeta || !activeGen) return null;

  const content = activeGen.pendingUserMessageContent ?? "";
  const pendingAttachments = activeGen.pendingUserMessageAttachments ?? [];
  const displayContent = macroContext && !isCoauthorMode ? replaceUiMacros(content, macroContext) : content;
  const author = { name: chatMeta.persona?.name ?? "", avatarAssetId: chatMeta.persona?.avatarAssetId ?? null, avatarCropJson: chatMeta.persona?.avatarCropJson ?? null, avatarSrc: chatMeta.persona ? resolveEntityAvatarUrl({ kind: "personas", id: chatMeta.persona.id, avatarExt: chatMeta.persona.avatarExt, avatarAssetId: chatMeta.persona.avatarAssetId, updatedAt: chatMeta.persona.updatedAt }) : null };

  return (
    <MessageShell
      messageId="__pending-user"
      chatId={chatMeta.activeChat?.id ?? ""}
      role="user"
      showSeparator={true}
      author={author}
      isUser={true}
      isGreeting={false}
      isEditing={false}
      isGenerating={false}
      isBusy={true}
      canBranch={false}
      canRegenerate={false}
      canResend={false}
      selectedVariantIndex={0}
      variantCount={1}
      canSwitchVariant={false}
      tokenCount={0}
      modelId=""
      createdAt={Date.now().toString()}
      copied={false}
      slotExtras={{}}
      variantControlsOverlay={null}
      variantControlsRef={variantControlsRef}
      actions={{
        onCopy: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onBranch: () => {},
        onRegenerate: () => {},
        onResend: () => {},
      }}
    >
      <div className={isMobile ? "my-0.5 rounded-md bg-user-bg" : "my-0.5 rounded-md bg-user-bg px-4 py-[13px]"} style={isMobile ? { padding: '10px 12px' } : undefined}>
        <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 opacity-88 [&_em]:italic [&_em]:text-msg-t2">
          <Markdown text={displayContent} />
        </div>
        <AttachmentGrid attachments={pendingAttachments} messageId={undefined} />
      </div>
    </MessageShell>
  );
}
