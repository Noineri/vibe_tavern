import { useEffect } from "react";
import { toast } from "sonner";
import { coauthorReviews } from "../lib/coauthor-draft.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";

/** One AppShell owner, not one subscription per message/editor. Entry and
 * settlement recover the server draft. A live reader exclusively owns tool
 * projection until it settles; leaving the view only invalidates this read. */
export function useCoauthorReviewPersistence(): void {
  const chatId = useChatStore((s) => s.activeChatId);
  const snapshotId = useSnapshotStore((s) => s.activeChat?.id);
  const mode = useSnapshotStore((s) => s.activeChat?.mode);
  const sending = useChatStore((s) => Boolean(s.activeChatId && s.generations[s.activeChatId]?.isSending));
  useEffect(() => {
    if (!chatId || snapshotId !== chatId || mode !== "coauthor" || sending) return;
    let current = true;
    const isCurrent = () => current && !useChatStore.getState().generations[chatId]?.isSending;
    void coauthorReviews.hydrate(chatId, isCurrent).catch((error: unknown) => {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [chatId, snapshotId, mode, sending]);
}
