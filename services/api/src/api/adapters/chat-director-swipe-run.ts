/**
 * The branch-pinned RP regeneration behind the Director swipe delegate
 * (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-24) — the adapter half of
 * `domain/director/director-swipe-delegate.ts`, extracted into this sibling at
 * the arch-gate size cap (chat-adapter.ts has no size headroom).
 *
 * This is the "internal branch-pinned regeneration entry" the unit prescribes:
 * it REUSES the server-owned `chat:<chatId>` run reservation and branch
 * pinning (`ChatGenerationRunAdapter.startOwnedChatGeneration` — the same
 * slot the manual regenerate occupies, so an already-running RP generation is
 * the registry's explicit `AgentRunActiveError` conflict, never a silent
 * queue) and runs exactly ONE ordinary STREAMING regeneration for the approved
 * request — the DMT-13 `requestInstruction` rides the ordinary
 * `LiveChatRegenerateInput`, the target thread's branch pins the generation
 * scope (completion updates the OWNING target even when another chat is
 * visible), and the variant/trace persist through the normal
 * `appendMessageVariant` path (the linked prompt trace carries the
 * request_instruction layer). No public HTTP route is called from the server.
 *
 * Outcome mapping: provider-grade failures are absorbed into the canonical
 * outcome (`failed` / `cancelled` on Stop/abort — the ordinary streaming
 * partial-save still applies) so the permission decision stays durable; a
 * reservation conflict throws out of the run start (an explicit refusal — the
 * row stays awaiting). The appended variant identity derives from the store's
 * variant set (the run's persistence is the one write path); the linked trace
 * is looked up by the appended variant id (`getTraceByVariant`).
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type { CoauthorTransport, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { AgentRunSubscription } from "../../domain/agent/agent-run-registry.js";
import type { ChatGenerationTurn } from "../contract/chat-runtime-contracts.js";
import type { LiveChatMediaInput } from "../../domain/chat/live-chat-send-input.js";
import type { DirectorSwipeGenerationService, DirectorSwipeRunOutcome, DirectorSwipeRunRequest } from "../../domain/director/director-swipe-delegate.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";

/** The ChatAdapter seams the run needs — narrow structural slots so this
 *  module owns no adapter state (the adapter binds them once in its
 *  constructor). `startGeneration` is the PROTECTED internal reservation entry:
 *  the chat-scoped run slot, the pinned branch, native-mode scoping. */
export interface BranchPinnedSwipeRunSeams {
	readonly stores: Pick<StoreContainer, "messages" | "traces">;
	/** The ordinary RP provider/model resolution (the manual regenerate's). */
	readonly resolveProfile: (chatId: string) => Promise<{ profile: StoredProviderProfileRecord & { defaultModel: string }; transport: CoauthorTransport }>;
	/** The ordinary reply media resolution (vision/voice — the manual
	 *  regenerate's `resolveReplyMediaAssets`). */
	readonly resolveMedia: (profile: StoredProviderProfileRecord & { defaultModel: string }) => Promise<LiveChatMediaInput>;
	/** The orchestrator's streaming regeneration (the DMT-13
	 *  `requestInstruction` rides its ordinary input). */
	readonly regenerateStream: (input: {
		readonly chatId: string;
		readonly messageId: string;
		readonly profile: StoredProviderProfileRecord & { defaultModel: string };
		readonly model: string;
		readonly transport: CoauthorTransport;
		readonly requestInstruction: string;
		readonly signal?: AbortSignal;
	} & LiveChatMediaInput) => AsyncGenerator<{ event: string; data: string }>;
	/** Reserve the chat run for the pinned branch (the PROTECTED
	 *  `startOwnedChatGeneration` with the internal branch scope override). */
	readonly startGeneration: (request: DirectorSwipeRunRequest, turn: ChatGenerationTurn) => Promise<AgentRunSubscription>;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Build the swipe generation service over the adapter seams — the ONE
 *  instance the runtime composition wires into the sidechat stream deps. */
export function createBranchPinnedSwipeRun(seams: BranchPinnedSwipeRunSeams): DirectorSwipeGenerationService {
	return {
		runBranchPinnedRegeneration: async (request: DirectorSwipeRunRequest): Promise<DirectorSwipeRunOutcome> => {
			// The ordinary RP resolution FIRST (outside the run): a missing
			// provider/model refuses the allowance explicitly, exactly like the
			// manual regenerate route would.
			const { profile, transport } = await seams.resolveProfile(request.chatId);
			const media = await seams.resolveMedia(profile);
			// The variant set BEFORE the run — the appended variant is the delta
			// (the run's own persistence is the one write path; no parallel
			// bookkeeping).
			const knownVariants = new Set(
				(await seams.stores.messages.getVariants(request.messageId)).map((variant) => variant.id),
			);
			let abortedByEvent = false;
			let failure: { readonly error: unknown } | undefined;
			const subscription = await seams.startGeneration(request, async function* (ownedSignal) {
				try {
					// The ordinary streaming regeneration — Stop/abort keeps the
					// streamed partial through the orchestrator's own onAbort path.
					yield* seams.regenerateStream({
						chatId: request.chatId,
						messageId: request.messageId,
						profile,
						model: profile.defaultModel,
						transport,
						requestInstruction: request.requestInstruction,
						signal: request.signal ? AbortSignal.any([ownedSignal, request.signal]) : ownedSignal,
						...media,
					});
				} catch (error) {
					failure = { error };
					throw error;
				}
			});
			// Join the registry's slot release (the run is server-owned: it
			// completes and persists regardless of any subscriber).
			for await (const frame of subscription) {
				if (frame.event === "abort") abortedByEvent = true;
			}
			if (failure !== undefined) {
				if (request.signal?.aborted || isAbortError(failure.error)) return { status: "cancelled" };
				return { status: "failed", reason: extractProviderErrorMessage(failure.error) };
			}
			if (abortedByEvent) return { status: "cancelled" };
			const appended = (await seams.stores.messages.getVariants(request.messageId)).filter(
				(variant) => !knownVariants.has(variant.id),
			);
			const variant = appended.length > 0 ? appended[appended.length - 1]! : null;
			if (variant === null) {
				// The provider produced no text — the ordinary path appends no
				// variant; report it honestly instead of inventing an identity.
				return { status: "no_output", messageId: request.messageId };
			}
			const trace = await seams.stores.traces.getTraceByVariant(request.chatId, request.branchId, variant.id);
			return {
				status: "completed",
				messageId: request.messageId,
				variantId: variant.id,
				traceId: trace?.id ?? null,
			};
		},
	};
}
