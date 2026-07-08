import { useRef } from "react";
import { useT } from "../../../i18n/context.js";
import { useChatMeta } from "../../../stores/chat-selectors.js";
import { useActiveGeneration } from "../../../stores/index.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { resolveEntityAvatarUrl } from "../../../lib/avatar.js";
import { MessageShell } from "../MessageShell.js";
import { StreamingMarkdown } from "../StreamingMarkdown.js";
import { GenerationDots } from "../variants/generation-dots.js";

/**
 * Pending-assistant singleton: renders the streaming assistant reply as it
 * arrives (StreamingMarkdown reveals the revealed-slice of streamingText; the
 * reasoning slot surfaces thinking tokens when present). One instance per
 * active generation (rendered by MessageBlock's main body on the
 * `__pending-assistant` early-return path).
 *
 * Broad-selector consumer (useChatMeta / useActiveGeneration) — the isolation
 * test's other named exception. Singleton, so the broad call is safe; it would
 * leak only if hoisted into the memoized main body. Extracted verbatim in
 * god-object audit step 3.
 */
export function PendingAssistantMessage() {
  const { t } = useT();
  const chatMeta = useChatMeta();
  const activeGen = useActiveGeneration();
  const isMobile = useIsMobile();
  const isCoauthorMode = useSnapshotStore(s => s.activeChat?.mode === "coauthor");
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  if (!chatMeta || !activeGen) return null;

  const author = { name: chatMeta.character.name, avatarAssetId: chatMeta.character.avatarAssetId, avatarCropJson: chatMeta.character.avatarCropJson, avatarSrc: resolveEntityAvatarUrl({ kind: "characters", id: chatMeta.character.id, avatarExt: chatMeta.character.avatarExt, avatarAssetId: chatMeta.character.avatarAssetId, updatedAt: chatMeta.character.updatedAt }) };
  const streamingText = activeGen.streamingText;
  const streamingRevealedText = activeGen.streamingRevealedText;
  const streamingReasoning = activeGen.streamingReasoningText;

  const reasoningForSlot = streamingReasoning ? {
    reasoning: streamingReasoning,
    reasoningDurationMs: null,
    variant: isCoauthorMode ? "minimal" : "rich",
  } : null;

  return (
    <MessageShell
      messageId="__pending-assistant"
      chatId={chatMeta.activeChat?.id ?? ""}
      role="assistant"
      showSeparator={true}
      author={author}
      isUser={false}
      isGreeting={false}
      isEditing={false}
      isGenerating={true}
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
      slotExtras={{ reasoning: reasoningForSlot }}
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
      <div className={isMobile ? "my-0.5 w-full" : ""}>
        <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
          {streamingText ? <StreamingMarkdown text={streamingRevealedText} /> : null}
          <GenerationDots label={t("generating_response")} />
        </div>
      </div>
    </MessageShell>
  );
}
