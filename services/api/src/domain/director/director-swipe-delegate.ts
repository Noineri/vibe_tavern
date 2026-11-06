/**
 * The Director swipe GENERATION delegate (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-24).
 *
 * An allowed `request_message_swipe` resumes through DMT-23's injected seam
 * (`SidechatStreamDeps.buildSwipeGenerationDelegate`); THIS module is the real
 * delegate: it revalidates the FROZEN TARGET against the thread's own branch
 * (the message and the variant recorded in the awaiting marker must still
 * exist there — a deleted/moved source refuses the allowance, it can never
 * redirect a confirmation onto different rows), then delegates the approved
 * request through a NARROW generation-service interface
 * ({@link DirectorSwipeGenerationService}). The service is implemented by the
 * chat adapter wiring (runtime-api-adapter): ONE ordinary server-owned RP
 * regeneration — the normal `chat:<chatId>` run reservation, the normal
 * branch-pinned lifecycle, the DMT-13 `requestInstruction` riding the ordinary
 * regeneration input — returning the CANONICAL outcome (appended variant
 * identity + the linked prompt trace). No parallel persistence path exists:
 * the variant and trace land through the ordinary generated-variant/trace
 * persistence exactly like a manual swipe.
 *
 * Failure surface (each with its lifecycle rule):
 * - Refusals THROW (the split-turn mechanism leaves the row awaiting): a
 *   corrupted/missing target, and the adapter's EXPLICIT run-reservation
 *   conflict (`AgentRunActiveError` — an already-running RP generation is
 *   never silently queued for the next free turn; the user allows again once
 *   the chat is free).
 * - Provider-grade failures are absorbed by the adapter into the outcome
 *   (`failed` / `cancelled`): the decision stays durable (the granted receipt
 *   stores the approved instruction — it belongs to the accepted invocation
 *   even when the provider fails or the user stops it) and the ordinary RP
 *   run's own Stop/replay channel carries the failure. The instruction is
 *   request-local: no later generation ever inherits it.
 *
 * Dependency direction: this module imports nothing from the adapter layer —
 * the adapters wire (the runtime composition implements the service over the
 * chat runtime); domain stays pure of adapters.
 */

import type { MessageStore } from "@vibe-tavern/db";
import type { DirectorSwipeRunOutcome } from "@vibe-tavern/api-contracts";
import type { DirectorSwipeGenerationDelegate, DirectorSwipeGenerationInput } from "../sidechat/sidechat-swipe-executor.js";
import { validation } from "../../shared/errors.js";

// ─── The narrow generation-service interface (implemented by the adapter) ────

/** One approved regeneration request, resolved to immutable identity: the
 *  THREAD ROW's chat + branch (never the browser's active chat), the marker's
 *  frozen target message, the FINAL user-approved instruction (the DMT-13
 *  one-shot request input — never persisted anywhere else), and the answer
 *  turn's cancellation signal. */
export interface DirectorSwipeRunRequest {
	readonly chatId: string;
	readonly branchId: string;
	readonly messageId: string;
	readonly requestInstruction: string;
	readonly signal?: AbortSignal;
}

/** The canonical outcome of the ONE approved regeneration — what an ordinary
 *  branch-pinned regeneration produces, never a custom payload: the appended
 *  variant identity plus its linked prompt trace (a provider that produced no
 *  text appends nothing), or the absorbed provider-grade failure. The shape is
 *  THE ONE shared contract (`directorSwipeRunOutcomeSchema`,
 *  `@vibe-tavern/api-contracts` — DMT-24b re-derives it here instead of a
 *  second hand-written union: the answer stream's outcome frame validates the
 *  same shape on the web). */
export type { DirectorSwipeRunOutcome };

/** The NARROW generation-service seam the chat adapter implements: reserve the
 *  normal `chat:<chatId>` run for the TARGET THREAD's branch and run exactly
 *  one ordinary RP regeneration with the approved instruction. Throws only for
 *  explicit refusals (the reservation conflict, a configuration gap) —
 *  provider-grade failures come back absorbed in the outcome. */
export interface DirectorSwipeGenerationService {
	runBranchPinnedRegeneration(request: DirectorSwipeRunRequest): Promise<DirectorSwipeRunOutcome>;
}

// ─── The delegate (revalidation + delegation) ────────────────────────────────

/** The message reads the revalidation runs through — the same narrow seam the
 *  DMT-21 target resolver uses (one wiring). */
export interface DirectorSwipeDelegateDeps {
	readonly messages: Pick<MessageStore, "getMessages" | "getVariantsByBranch">;
	readonly generation: DirectorSwipeGenerationService;
}

/**
 * Run one ALLOWED swipe request: revalidate the frozen target in the thread's
 * branch, then delegate through the narrow generation service.
 *
 * Revalidation reads the branch's message list and variant set through the
 * injected stores and requires exactly what the marker froze: a COMMITTED
 * ASSISTANT reply at the recorded id carrying the recorded variant. A refusal
 * throws BEFORE any provider call — the split-turn mechanism leaves the row
 * awaiting, nothing is generated, and the stored decision cannot redirect onto
 * different rows (deletion, a reused position or a stale source can never
 * retarget a confirmation).
 *
 * @throws {@link validation} when the recorded message no longer resolves in
 *   the thread's branch (deleted, moved to another branch, no longer a
 *   committed assistant reply, or its variant rows are gone) — and whatever
 *   the generation service throws (the explicit run-reservation conflict).
 */
export async function runDirectorSwipeGeneration(
	input: DirectorSwipeGenerationInput,
	deps: DirectorSwipeDelegateDeps,
): Promise<DirectorSwipeRunOutcome> {
	const branchMessages = await deps.messages.getMessages(input.branchId);
	const message = branchMessages.find((row) => row.id === input.marker.messageId);
	if (message === undefined) {
		throw validation(
			"request_message_swipe: the approved reply no longer exists in this thread's branch — the allowance cannot run.",
		);
	}
	if (message.role !== "assistant" || message.state !== "complete") {
		throw validation(
			`request_message_swipe: the approved message is no longer a committed assistant reply (role '${message.role}', state '${message.state}') — the allowance cannot run.`,
		);
	}
	const variants = (await deps.messages.getVariantsByBranch(input.branchId)).get(input.marker.messageId) ?? [];
	if (!variants.some((variant) => variant.id === input.marker.variantId)) {
		throw validation(
			"request_message_swipe: the approved swipe no longer exists on that reply — the allowance cannot run.",
		);
	}
	return await deps.generation.runBranchPinnedRegeneration({
		chatId: input.chatId,
		branchId: input.branchId,
		messageId: input.marker.messageId,
		requestInstruction: input.instruction,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
}

/** Bind the revalidating delegate over its deps — the factory the runtime
 *  composition hands to `SidechatStreamDeps.buildSwipeGenerationDelegate` (the
 *  DMT-23 seam's shape: lazily resolved per call, so a turn that never allows
 *  a swipe pays nothing). */
export function createDirectorSwipeGenerationDelegate(deps: DirectorSwipeDelegateDeps): DirectorSwipeGenerationDelegate {
	return (input) => runDirectorSwipeGeneration(input, deps);
}
