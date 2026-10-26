/**
 * Branch sidechat fork (SIDECHAT_PLAN Wave 5 / SC-20) — the logic behind
 * `POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat`
 * `{ targetBranchId }` and
 * `GET  /api/agent/chats/:chatId/branches/:branchId/sidechat-summary`.
 *
 * The fork copies the source branch's ACTIVE chat-owned threads — every agent
 * kind the store actually has rows for, never a hand-enumerated list — onto
 * the target branch, and copies the source branch's agent plan (SC-0h) onto
 * the target branch. Per thread the copy carries messages, frozen-context
 * events, context links, and todo, with metrics reset; the source is never
 * touched (test-pinned).
 *
 * THE FORK POINT comes from the target branch row, never the request:
 * `chat_branches.parent_branch_id` must equal the source branch (a typed 400
 * otherwise — {@link FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE}, the lowercase
 * family of `attached_variant_not_in_branch`), and the position is that of
 * the target's `forked_from_message_id` in the SOURCE branch. Chat-store
 * `forkBranch` already copied the RP messages/variants up to that position
 * into the target with NEW ids (keeping position + variantIndex), so the
 * sidechat copy must re-key its id references onto those new ids.
 *
 * ID REMAPPING (Wave 5 review 2026-10-21). A copied thread that kept the
 * SOURCE message ids would, on its first sync in the target branch, find
 * none of its frontier's `selected` ids (computeRpSync detects new messages
 * BY ID) and re-freeze the whole history up to the fork as a second
 * `rp_sync` — the assistant would read the RP twice — and the frozen-text
 * lookup behind `selection_changed` would miss. So the copy maps old → new
 * ids by (position, variantIndex) between the source and target branches:
 *
 * - `rp_sync` payload message entries whose message id has a target twin are
 *   re-keyed (id + variantId when a twin variant exists); entries past the
 *   fork point are dropped together with their frontier claims — that
 *   content is not the target's history. The bracket recomputes to the kept
 *   entries. A row whose every entry is past the fork drops entirely.
 * - `selection_changed` rows whose messageId has a twin are re-keyed
 *   (previous/current variantIds re-keyed when twins exist); rows for
 *   messages past the fork drop entirely.
 * - A variantId with no twin stays RAW: the pair rides its own frozen text,
 *   so the frozen-text lookup still resolves it, and the frontier can name
 *   it without a miss. Frozen TEXT is never touched.
 * - `variants_attached` / `branch_forked` payloads carry no ids — rows past
 *   the fork point (by `position` / `at`) drop, everything else copies
 *   verbatim.
 * - The frontier's `selected` is RE-DERIVED by replaying the remapped events
 *   in timeline order (the same evolution computeRpSync applies), so every
 *   value it names provably appears in a copied payload — the frozen-lookup
 *   invariant holds by construction. `lastPosition` =
 *   min(source value, fork point) — the plan's rule.
 *
 * The store half (`ExperienceCopilotStore.forkChatThreadToBranch`, backed by
 * packages/db's experience-copilot-fork-copy.ts) does the row copy in ONE
 * synchronous transaction; this module supplies the pure remap hooks above
 * and the trailing `branch_forked { at: forkPosition }` event — the stored
 * shape `parseBranchForkedPayload` (sidechat-context.ts) reads and SC-19b's
 * web separator renders.
 */

import type {
	AgentThreadContextEventKind,
	AgentThreadRpFrontier,
	AgentThreadTimelineEntry,
	ChatStore,
	ExperienceCopilotStore,
	ForkThreadRemap,
	Message,
	MessageStore,
	MessageVariant,
	StoreContainer,
} from "@vibe-tavern/db";
import { isRecord } from "@vibe-tavern/domain";
import { notFound, validation } from "../../shared/errors.js";
import { parseFrontier } from "@vibe-tavern/db";
import {
	findBranchOfChat,
	requireChatBranch,
	type ChatBranchLookup,
} from "../chat/chat-branch-ownership.js";

/**
 * Typed-validation code (SC-20): the fork target is not a child of the source
 * branch — `chat_branches.parent_branch_id` of the target does not equal the
 * source branch, the target has no `forked_from_message_id`, or that message
 * no longer resolves in the source branch (the fork point cannot be derived
 * from the target row). DomainError `Validation` (the 400 family) with this
 * code in `details`, the same lowercase family as
 * `attached_variant_not_in_branch`.
 */
export const FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE = "target_branch_not_child_of_source";

/** The fork target must be the FRESHLY CREATED child branch of the UI's
 *  fork action — it cannot carry a sidechat session yet (owner 2026-10-21:
 *  an occupied target is an impossible scenario in the real flow). A caller
 *  that reaches this refusal misused the route, and misuse must fail LOUD —
 *  never silently archive/replace the target's existing conversation. */
export const FORK_TARGET_THREAD_ACTIVE_CODE = "target_branch_thread_active";

/** One copied thread on the fork result: the new thread's id and its agent
 *  kind (the kind is copied from the source thread by the store). */
export interface CopiedSidechatThread {
	threadId: string;
	agentKind: string;
}

/** The summary shape `GET …/sidechat-summary` answers: whether the branch
 *  has any ACTIVE (non-archived) chat-owned thread sessions, and how many. */
export interface BranchSidechatSummary {
	hasSessions: boolean;
	count: number;
}

/** The stores/services the fork goes through — `Pick`s so tests and callers
 *  pass narrow seams instead of whole containers (the rp-sync pattern). */
export interface BranchSidechatForkDeps {
	/** Ownership pair checks — the shared SC-0l module, never a private copy. */
	chats: ChatBranchLookup;
	/** Branch message/variant reads for the (position, variantIndex) remap. */
	messages: Pick<MessageStore, "getMessages" | "getVariantsByBranch">;
	/** The thread store: the active-branch listing and the fork copy. */
	experienceCopilot: Pick<ExperienceCopilotStore, "listActiveChatThreadsForBranch" | "listTimeline" | "forkChatThreadToBranch">;
	/** The SC-0h branch-plan store: the source branch's plan copies to the target. */
	plans: Pick<StoreContainer["agentPlans"], "get" | "save">;
}

// ─── The pure id remap (old → new by position + variantIndex) ────────────────

/** The message/variant id translation between the source and target branch
 *  rows (SC-20): every entry maps a source id to the target twin of the SAME
 *  (position) / (position, variantIndex). Ids without a twin (positions past
 *  the fork point, or variants the fork never copied) are simply absent. */
export interface ForkIdRemap {
	readonly messageIds: ReadonlyMap<string, string>;
	readonly variantIds: ReadonlyMap<string, string>;
}

/** Build the id remap from the two branches' rows (PURE). Only source
 *  messages at positions ≤ the fork point participate — the fork copied
 *  exactly that prefix, so every other source row has no target twin. */
export function buildForkIdRemap(input: {
	sourceMessages: readonly Message[];
	targetMessages: readonly Message[];
	sourceVariants: ReadonlyMap<string, readonly MessageVariant[]>;
	targetVariants: ReadonlyMap<string, readonly MessageVariant[]>;
	forkPosition: number;
}): ForkIdRemap {
	const targetByPosition = new Map<number, Message>();
	for (const message of input.targetMessages) {
		if (message.position <= input.forkPosition) targetByPosition.set(message.position, message);
	}

	const messageIds = new Map<string, string>();
	const variantIds = new Map<string, string>();
	for (const source of input.sourceMessages) {
		if (source.position > input.forkPosition) continue;
		const target = targetByPosition.get(source.position);
		if (target === undefined) continue;
		messageIds.set(source.id, target.id);
		const sourceVariants = input.sourceVariants.get(source.id) ?? [];
		const targetVariants = input.targetVariants.get(target.id) ?? [];
		for (const variant of sourceVariants) {
			const twin = targetVariants.find((candidate) => candidate.variantIndex === variant.variantIndex);
			if (twin !== undefined) variantIds.set(variant.id, twin.id);
		}
	}
	return { messageIds, variantIds };
}

/** What one source event payload becomes after the remap: copied verbatim,
 *  rewritten (re-keyed id references), or dropped (references past the fork). */
export type ForkEventPayloadOutcome =
	| { action: "keep" }
	| { action: "rewrite"; payload: unknown }
	| { action: "drop" };

/**
 * Remap ONE frozen-event payload for the fork copy (PURE). The kind-by-kind
 * rules are the module's contract (see the header); unknown kinds and
 * structurally invalid payloads copy verbatim — the parsers downstream skip
 * corrupt rows exactly as they did on the source, so corruption never gets
 * quieter or louder for the copy.
 */
export function remapEventPayloadForFork(
	remap: ForkIdRemap,
	forkPosition: number,
	kind: AgentThreadContextEventKind,
	payload: unknown,
): ForkEventPayloadOutcome {
	if (kind === "rp_sync") {
		if (!isRecord(payload) || !Array.isArray(payload.messages)) return { action: "keep" };
		const kept: unknown[] = [];
		let changed = false;
		for (const entry of payload.messages) {
			if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.position !== "number") continue;
			const messageId = remap.messageIds.get(entry.id);
			if (messageId === undefined) continue; // past the fork point: not the target's history
			const variantId =
				typeof entry.variantId === "string"
					? remap.variantIds.get(entry.variantId) ?? entry.variantId // no twin → raw (its text rides along)
					: entry.variantId;
			if (messageId !== entry.id || variantId !== entry.variantId) {
				changed = true;
				kept.push({ ...entry, id: messageId, variantId });
			} else {
				kept.push(entry);
			}
		}
		if (kept.length === 0) return { action: "drop" };
		if (!changed) return { action: "keep" };
		const first = kept[0] as { position: number };
		const last = kept[kept.length - 1] as { position: number };
		return {
			action: "rewrite",
			payload: { ...payload, messages: kept, fromPosition: first.position, toPosition: last.position },
		};
	}

	if (kind === "selection_changed") {
		if (!isRecord(payload) || typeof payload.messageId !== "string") return { action: "keep" };
		const messageId = remap.messageIds.get(payload.messageId);
		if (messageId === undefined) return { action: "drop" }; // message past the fork point
		const remapPair = (pair: unknown): { pair: unknown; changed: boolean } => {
			if (!isRecord(pair) || typeof pair.variantId !== "string") return { pair, changed: false };
			const variantId = remap.variantIds.get(pair.variantId);
			if (variantId === undefined || variantId === pair.variantId) return { pair, changed: false };
			return { pair: { ...pair, variantId }, changed: true };
		};
		const previous = remapPair(payload.previous);
		const current = remapPair(payload.current);
		if (!previous.changed && !current.changed && messageId === payload.messageId) return { action: "keep" };
		return {
			action: "rewrite",
			payload: { ...payload, messageId, previous: previous.pair, current: current.pair },
		};
	}

	if (kind === "variants_attached") {
		if (isRecord(payload) && typeof payload.position === "number" && payload.position > forkPosition) {
			return { action: "drop" };
		}
		return { action: "keep" };
	}

	if (kind === "branch_forked") {
		if (isRecord(payload) && typeof payload.at === "number" && payload.at > forkPosition) {
			return { action: "drop" };
		}
		return { action: "keep" };
	}

	return { action: "keep" };
}

/**
 * The store-level decision hook over payload JSON strings (PURE closure over
 * the remap): parses, routes through {@link remapEventPayloadForFork}, and
 * maps the outcome onto the store's copy contract — original bytes for
 * `keep` (no re-serialization churn), a fresh JSON string for `rewrite`,
 * `drop` for `drop`. Null and unparseable payloads copy as-is (null is a
 * legal column state; a malformed string stays malformed — the parsers
 * skip it, same as on the source).
 */
export function forkEventPayloadDecider(
	remap: ForkIdRemap,
	forkPosition: number,
): ForkThreadRemap["eventPayload"] {
	return (kind, payloadJson) => {
		if (payloadJson === null) return { payloadJson: null };
		let parsed: unknown;
		try {
			parsed = JSON.parse(payloadJson);
		} catch {
			return { payloadJson };
		}
		const outcome = remapEventPayloadForFork(remap, forkPosition, kind, parsed);
		if (outcome.action === "drop") return { drop: true };
		if (outcome.action === "keep") return { payloadJson };
		return { payloadJson: JSON.stringify(outcome.payload) };
	};
}

/**
 * Derive the COPIED thread's frontier (PURE): replay the remapped events in
 * timeline order and apply computeRpSync's own frontier evolution — an
 * rp_sync entry freezes (messageId, variantId), a selection_changed's
 * `current` re-freezes its message — so every `selected` value provably
 * appears in a copied payload (the frozen-lookup invariant, by construction;
 * the source frontier's own values are NOT trusted: they may name variants
 * no copied event carries). `lastPosition` is the plan's rule:
 * min(source value, fork point). A null source frontier (never synced)
 * stays null — the copy starts never-synced like its source.
 */
export function remapFrontierForFork(
	remap: ForkIdRemap,
	forkPosition: number,
	sourceFrontier: AgentThreadRpFrontier,
	sourceEvents: readonly AgentThreadTimelineEntry[],
): AgentThreadRpFrontier {
	const selected: Record<string, string> = {};
	for (const entry of sourceEvents) {
		if (entry.rowType !== "event") continue;
		const outcome = remapEventPayloadForFork(remap, forkPosition, entry.kind, entry.payload);
		if (outcome.action !== "rewrite") continue;
		if (outcome.payload !== null && typeof outcome.payload === "object") {
			const payload = outcome.payload as Record<string, unknown>;
			if (entry.kind === "rp_sync" && Array.isArray(payload.messages)) {
				for (const message of payload.messages) {
					if (isRecord(message) && typeof message.id === "string" && typeof message.variantId === "string") {
						selected[message.id] = message.variantId;
					}
				}
			} else if (entry.kind === "selection_changed") {
				const current = payload.current;
				if (isRecord(current) && typeof current.variantId === "string") {
					selected[payload.messageId as string] = current.variantId;
				}
			}
		}
	}
	return { lastPosition: Math.min(sourceFrontier.lastPosition, forkPosition), selected };
}

// ─── The orchestrator ────────────────────────────────────────────────────────

/** The typed 400: the target is not a usable fork of the source. */
function forkTargetNotChild(chatId: string, sourceBranchId: string, targetBranchId: string): never {
	throw validation(
		`Branch '${targetBranchId}' is not a fork of branch '${sourceBranchId}' (chat '${chatId}'): ` +
			"the fork target's parent_branch_id must be the source branch and its fork point must resolve there.",
		{
			code: FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE,
			sourceBranchId,
			targetBranchId,
		},
	);
}

function forkTargetOccupied(
	chatId: string,
	sourceBranchId: string,
	targetBranchId: string,
	activeThreads: number,
): never {
	throw validation(
		`Branch '${targetBranchId}' (fork of '${sourceBranchId}', chat '${chatId}') already has ` +
			`${activeThreads} active chat-owned thread(s): the fork target must be the freshly created branch — ` +
			"a sidechat copy never replaces an existing conversation.",
		{
			code: FORK_TARGET_THREAD_ACTIVE_CODE,
			sourceBranchId,
			targetBranchId,
		},
	);
}

/**
 * Fork a branch's sidechat onto one of its child branches (SC-20): copy every
 * ACTIVE chat-owned thread of the source branch onto the target branch and
 * copy the source branch's agent plan. Returns the copied threads (their new
 * ids and kinds). The source branch, its threads, and its plan are never
 * modified; archived source sessions are not copied.
 *
 * Failure shapes, in the SC-0b family order: missing chat or source branch →
 * 404 `notFound`; missing/foreign target branch → 404 `notFound`; a target
 * that is not a child of the source (or whose fork point no longer resolves)
 * → the typed 400 {@link FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE}.
 */
export async function forkBranchSidechat(
	deps: BranchSidechatForkDeps,
	chatId: string,
	sourceBranchId: string,
	targetBranchId: string,
): Promise<readonly CopiedSidechatThread[]> {
	const { branch: sourceBranch } = await requireChatBranch(deps.chats, chatId, sourceBranchId);
	const targetBranch = await findBranchOfChat(deps.chats, chatId, targetBranchId);
	if (targetBranch === null) {
		throw notFound("ChatBranch", `Branch '${targetBranchId}' was not found for chat '${chatId}'.`);
	}
	if (targetBranch.parentBranchId !== sourceBranch.id || targetBranch.forkedFromMessageId === null) {
		forkTargetNotChild(chatId, sourceBranch.id, targetBranch.id);
	}

	// The fork point from the TARGET row: the position of the message the
	// target branch was forked from, read in the SOURCE branch's rows.
	const sourceMessages = await deps.messages.getMessages(sourceBranch.id);
	const forkMessage = sourceMessages.find((message) => message.id === targetBranch.forkedFromMessageId);
	if (forkMessage === undefined) {
		forkTargetNotChild(chatId, sourceBranch.id, targetBranch.id);
	}
	const forkPosition = forkMessage.position;

	// The occupied-target refusal (see FORK_TARGET_THREAD_ACTIVE_CODE): the
	// UI forks into a branch it just created, so an ACTIVE thread on the
	// target means route misuse — typed 400, nothing copied.
	const occupied = await deps.experienceCopilot.listActiveChatThreadsForBranch(chatId, targetBranch.id);
	if (occupied.length > 0) {
		forkTargetOccupied(chatId, sourceBranch.id, targetBranch.id, occupied.length);
	}

	const remap = buildForkIdRemap({
		sourceMessages,
		targetMessages: await deps.messages.getMessages(targetBranch.id),
		sourceVariants: await deps.messages.getVariantsByBranch(sourceBranch.id),
		targetVariants: await deps.messages.getVariantsByBranch(targetBranch.id),
		forkPosition,
	});
	const eventPayload = forkEventPayloadDecider(remap, forkPosition);

	const actives = await deps.experienceCopilot.listActiveChatThreadsForBranch(chatId, sourceBranch.id);
	const copied: CopiedSidechatThread[] = [];
	for (const thread of actives) {
		if (thread.agentKind === null || thread.chatId === null) continue; // unreachable: chat-owned rows carry the triple
		// The remap closure's inputs are pre-read here (outside the copy tx) —
		// the same read-outside-write acceptance applyRpSync documents for the
		// single-process synchronous runtime.
		const timeline = await deps.experienceCopilot.listTimeline(thread.id);
		const newThread = await deps.experienceCopilot.forkChatThreadToBranch(thread.id, targetBranch.id, {
			eventPayload,
			frontierJson: (sourceFrontierJson) => {
				if (sourceFrontierJson === null) return null;
				const parsed = parseFrontier(sourceFrontierJson, thread.id);
				if (parsed === null) return sourceFrontierJson; // malformed on disk — copies verbatim, the next sync heals it
				return JSON.stringify(remapFrontierForFork(remap, forkPosition, parsed, timeline));
			},
			trailingEvent: { kind: "branch_forked", payload: { at: forkPosition } },
		});
		if (newThread !== null && newThread.agentKind !== null) {
			copied.push({ threadId: newThread.id, agentKind: newThread.agentKind });
		}
	}

	// The branch plan (SC-0h): the source's plan copies onto the target
	// branch. A source with no plan copies nothing — the target keeps whatever
	// plan it already has.
	const plan = await deps.plans.get({ kind: "chatBranch", chatId, branchId: sourceBranch.id });
	if (plan !== null) {
		await deps.plans.save({ kind: "chatBranch", chatId, branchId: targetBranch.id }, plan);
	}

	return copied;
}

/**
 * The confirms' summary (SC-20/SC-21): whether the branch has any ACTIVE
 * (non-archived) chat-owned thread sessions, and how many. Missing chat or
 * branch → the SC-0b family's 404s.
 */
export async function summarizeBranchSidechat(
	deps: Pick<BranchSidechatForkDeps, "chats" | "experienceCopilot">,
	chatId: string,
	branchId: string,
): Promise<BranchSidechatSummary> {
	await requireChatBranch(deps.chats, chatId, branchId);
	const count = (await deps.experienceCopilot.listActiveChatThreadsForBranch(chatId, branchId)).length;
	return { hasSessions: count > 0, count };
}
