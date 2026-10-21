/**
 * The "discuss in the sidechat" variant-attachment freeze (SIDECHAT_PLAN
 * Wave 5 / SC-17) — the writer behind the stream request's `attachedVariants`
 * field.
 *
 * The user attaches RP variants (swipe alternatives) to a sidechat turn; the
 * server freezes their texts into the thread's timeline BEFORE the generic
 * loop persists the user message (and AFTER SC-2c's `syncBeforeUserMessage`,
 * so this turn's freshly frozen rows sit at seqs ABOVE the sync's delta and
 * BELOW the user message on the merged timeline — the same anchoring the
 * sync's events use).
 *
 * WHAT IS FROZEN (the owner-settled shape, SC-3a/SC-3b's payload contract):
 * ONE `variants_attached` event PER attached message — the stored payload and
 * its renderer carry one message (`{ position, variants: [{ text, selected }] }`,
 * sidechat-xml.ts `VariantsAttachedPayload`, parsed back by
 * sidechat-context.ts `parseVariantsAttachedPayload`) — so variants of two
 * messages never share an event. Events are appended in MESSAGE POSITION
 * order, never request array order. Each text goes through SC-2a's shared
 * reader (`readBranchAsModelSees` named-variants arm — the same
 * buildPipelineContext inputs and resolveHistoryAsModelSees per-message
 * transform as the selected texts), so an alternative reads the way the RP
 * model would have received it; the raw stored content never reaches the
 * model. `selected` is the RP's own state (`message_variants.is_selected`)
 * read at freeze time — the request names only the pairs, never a marker.
 *
 * ALL-OR-NOTHING: every pair is validated (message belongs to the thread's
 * own chat + branch, variant to its message) inside the ONE reader pass
 * BEFORE the first event is appended — a foreign message or variant throws
 * the typed validation (`attached_variant_not_in_branch`, the DomainError
 * 400 family) and NOTHING is frozen, valid pairs included. The RP selection
 * itself never changes: this module only reads `message_variants` and writes
 * thread timeline events.
 */

import {
	brandId,
	type ChatBranchId,
	type ChatId,
	type ExperienceCopilotThreadId,
} from "@vibe-tavern/domain";
import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { RpSyncThreadNotChatOwnedError } from "./rp-sync.js";
import {
	readBranchAsModelSees,
	type AttachedVariantPair,
	type RpBranchViewDeps,
	type RpBranchViewNamedVariant,
} from "./rp-branch-view.js";

/** The stores/services the freeze goes through: the SC-2a reader deps plus
 *  the agent-thread store's thread row read and the generic frozen-event
 *  append (`appendContextEvent` — the same seam the timeline's other event
 *  kinds ride). */
export interface VariantAttachDeps extends RpBranchViewDeps {
	readonly experienceCopilot: Pick<ExperienceCopilotStore, "getById" | "appendContextEvent">;
}

/** The composite key the pair dedupe and the grouping share (the `\u0000`
 *  separator style of rp-sync's frozen-text lookup — cannot appear in a
 *  generated id, so the composite never collides with a real one). */
function pairKey(pair: AttachedVariantPair): string {
	return `${pair.messageId}\u0000${pair.variantId}`;
}

/**
 * Freeze the attached variants as `variants_attached` timeline events
 * (SC-17). Order: sync already ran (the caller is the sidechat turn's
 * loadContext seam); this freezes, then the generic loop persists the user
 * message — the events anchor below it on the merged timeline.
 *
 * A script-owned/draft thread is refused with {@link RpSyncThreadNotChatOwnedError}
 * before any RP-chat read (the same typed refusal the sync uses — unreachable
 * through the sidechat dispatch, the corruption guard). An empty pair list is
 * a no-op. Throws the reader's typed validation for a non-resolving pair —
 * nothing is frozen in that case.
 */
export async function attachVariantsBeforeUserMessage(
	deps: VariantAttachDeps,
	threadId: ExperienceCopilotThreadId,
	pairs: readonly AttachedVariantPair[],
): Promise<void> {
	if (pairs.length === 0) return;

	const thread = await deps.experienceCopilot.getById(threadId);
	// Same narrowing as syncBeforeUserMessage (SC-2c): a null branchId on a
	// chat-owned row is corruption — refused, never read through.
	if (thread === null || !isChatOwnedAgentThread(thread) || thread.branchId === null) {
		throw new RpSyncThreadNotChatOwnedError(threadId);
	}

	// Exact-duplicate pairs add nothing (the variant would render twice inside
	// its message's event) — dedupe before the read.
	const unique = [...new Map(pairs.map((pair) => [pairKey(pair), pair])).values()];

	// The ONE reader pass: validates every pair against the thread's own chat +
	// branch rows and transforms the texts (SC-2a's seam). A foreign message or
	// variant throws the typed validation HERE — before the first append below,
	// so nothing is frozen for the valid pairs either (all-or-nothing).
	const view = await readBranchAsModelSees(
		deps,
		brandId<ChatId>(thread.chatId),
		brandId<ChatBranchId>(thread.branchId),
		unique,
	);
	// The owner pair came from the thread's own row; a null view means the owner
	// branch does not resolve — the same mid-delete race the sync documents
	// (unreachable outside it); there is nothing to attach to either way.
	if (view === null || view.namedVariants === undefined) {
		throw new Error(
			`attachVariantsBeforeUserMessage: thread "${threadId}" owns chat ${thread.chatId} / ` +
				`branch ${thread.branchId}, but the named-variant read did not resolve (deleted mid-freeze?)`,
		);
	}

	// ONE event per attached MESSAGE (variants of one message share their
	// message's event; two messages never share one), appended in MESSAGE
	// POSITION order — never the request array order.
	const byMessage = new Map<string, RpBranchViewNamedVariant[]>();
	for (const variant of view.namedVariants) {
		const group = byMessage.get(variant.messageId);
		if (group === undefined) byMessage.set(variant.messageId, [variant]);
		else group.push(variant);
	}
	const groups = [...byMessage.values()].sort(
		(a, b) => a[0]!.position - b[0]!.position,
	);

	for (const group of groups) {
		await deps.experienceCopilot.appendContextEvent(threadId, "variants_attached", {
			position: group[0]!.position,
			variants: group.map((variant) => ({
				text: variant.text,
				selected: variant.selected,
			})),
		});
	}
}
