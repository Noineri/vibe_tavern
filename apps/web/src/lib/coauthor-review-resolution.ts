import type { AgentReviewSnapshot } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import { getT } from "../i18n/locale-helpers.js";
import { useCoauthorTurnStore, type CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { coauthorReviews } from "./coauthor-draft.js";
import { resolveCoauthorReview } from "./coauthor-editor-snapshot.js";

/** Durable rejection first; only then dismiss the originating local review.
 * A late response must leave a replacement turn/session intact. */
export async function rejectCoauthorReview(input: {
  chatId: string | null;
  characterId: string;
  activities: CoauthorToolActivity[];
  liveActivities: CoauthorToolActivity[];
  review: AgentReviewSnapshot;
  applying: boolean;
  setApplying: (value: boolean) => void;
  markResolved: () => void;
}): Promise<void> {
  if (!input.chatId || input.applying) return;
  input.setApplying(true);
  try {
    await coauthorReviews.resolve(input.chatId, input.activities);
    const current = useCoauthorTurnStore.getState().turnsByChat[input.chatId];
    resolveCoauthorReview(input.chatId, input.characterId, input.review, { clearSession: current === undefined || current === input.liveActivities });
    if (current === input.liveActivities) useCoauthorTurnStore.getState().clearTurn(input.chatId);
    input.markResolved();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : getT()("request_failed"));
  } finally { input.setApplying(false); }
}
