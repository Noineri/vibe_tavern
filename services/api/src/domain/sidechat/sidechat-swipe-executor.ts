/**
 * The granted execution of one allowed `request_message_swipe` — DMT-23's
 * executor, EXTRACTED verbatim out of `sidechat-stream.ts` in DMT-24b (the
 * arch-gate file-size ratchet: the swipe outcome surfacing pushed the stream
 * module over the 800-line cap, and the executor is exactly the part that
 * unit changed). The stream module's `runWaitTool` seam dispatches here for
 * the swipe family; the seam TYPES the real delegate implements
 * (`director-swipe-delegate.ts` → the chat adapter's branch-pinned RP
 * regeneration) live beside their consumer.
 *
 * Behavior contract (unchanged by the extraction): the recorded awaiting
 * output is revalidated through the DMT-11 marker schema (a corrupted row is
 * refused, never resumed on guessed state — the `runGrantedPromptRead`
 * precedent); the FINAL approved instruction is the user-edited text when
 * the Allow answer carried one and the recorded draft otherwise, trimmed and
 * REQUIRED non-empty (an empty approval generates nothing — refused, the row
 * stays awaiting); the ONE generation runs through the injected delegate
 * (absent → refuse loudly BEFORE any state change); the granted receipt
 * carries that final text (the DMT-11 receipt schema — the request-local
 * instruction is never persisted anywhere else). Deny never reaches this
 * executor: the mechanism itself stores `{ status: "denied" }`.
 *
 * DMT-24b (owner ruling 2026-11-06, swipe-run failure surfacing): the
 * delegate's outcome is READ, not discarded — a provider-grade failure is
 * absorbed by the adapter into the outcome (the decision stays durable), so
 * this executor returns the receipt AND the outcome separately: the receipt
 * persists (the answer request still succeeds), the outcome rides back to
 * the stream for its tail frame (the established generation-failure toast;
 * the stream module owns the frame).
 */

import type {
  DirectorSwipeGrantedReceipt,
  DirectorSwipePermissionMarker,
  DirectorSwipeRunOutcome,
} from "@vibe-tavern/api-contracts";
import { directorSwipePermissionMarkerSchema } from "@vibe-tavern/api-contracts";
import { validation } from "../../shared/errors.js";
import type { AgentPermissionContinuation } from "../agent/agent-split-turn.js";

/** The swipe GENERATION delegate's input: the recorded awaiting marker (the
 *  DMT-11 shape, revalidated by the executor before this call — the frozen
 *  target identity's source of truth), the FINAL user-approved instruction
 *  text, the THREAD ROW's own branch scope (never the request), and the
 *  answer turn's cancellation signal. */
export interface DirectorSwipeGenerationInput {
  readonly chatId: string;
  readonly branchId: string;
  readonly marker: DirectorSwipePermissionMarker;
  readonly instruction: string;
  readonly signal?: AbortSignal;
}

/** The ONE generation an allowed swipe request may run (DMT-23's injected
 *  seam; DMT-24 supplies the real branch-pinned RP generation over the
 *  normal lifecycle). Exactly one call per accepted permission answer — the
 *  mechanism's duplicate-decision guards are the split-turn module's. DMT-24b:
 *  the delegate returns the CANONICAL run outcome (the shared
 *  {@link DirectorSwipeRunOutcome} contract) — the granted executor reads it
 *  to surface an absorbed failure (the established generation-failure toast;
 *  owner ruling 2026-11-06) instead of discarding it. */
export type DirectorSwipeGenerationDelegate = (
  input: DirectorSwipeGenerationInput,
) => Promise<DirectorSwipeRunOutcome>;

/**
 * Run one ALLOWED `request_message_swipe` (dispatched beside the prompt read
 * in the seams' `runWaitTool`).
 *
 * @throws {@link validation} when the recorded output is not the marker
 *   shape, when the final instruction is empty, or when no generation
 *   delegate is wired (and whatever the delegate itself throws).
 */
export async function runGrantedMessageSwipe(input: {
  readonly threadOwner: { readonly chatId: string; readonly branchId: string };
  readonly continuation: AgentPermissionContinuation;
  readonly signal?: AbortSignal;
  readonly buildSwipeGenerationDelegate?: () => Promise<DirectorSwipeGenerationDelegate | undefined>;
}): Promise<{ receipt: DirectorSwipeGrantedReceipt; outcome: DirectorSwipeRunOutcome }> {
  const marker = directorSwipePermissionMarkerSchema.safeParse(input.continuation.awaitingOutput);
  if (!marker.success) {
    throw validation(
      "The recorded request_message_swipe output is not the tool's marker shape — refusing to resume it.",
    );
  }
  const finalInstruction = (input.continuation.instruction ?? marker.data.instruction).trim();
  if (finalInstruction.length === 0) {
    throw validation(
      "The approved swipe instruction is empty — refusing to run the generation without text.",
    );
  }
  const delegate =
    input.buildSwipeGenerationDelegate === undefined
      ? undefined
      : await input.buildSwipeGenerationDelegate();
  if (delegate === undefined) {
    throw validation(
      "request_message_swipe: swipe generation is not configured — the allowance cannot run.",
    );
  }
  const outcome = await delegate({
    chatId: input.threadOwner.chatId,
    branchId: input.threadOwner.branchId,
    marker: marker.data,
    instruction: finalInstruction,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const receipt: DirectorSwipeGrantedReceipt = {
    status: "granted",
    messageId: marker.data.messageId,
    variantId: marker.data.variantId,
    position: marker.data.position,
    variantNumber: marker.data.variantNumber,
    replyFirstLine: marker.data.replyFirstLine,
    instruction: finalInstruction,
  };
  return { receipt, outcome };
}
