/**
 * Sidechat-OOC compaction service (SIDECHAT_PLAN, Wave 2 / SC-8c) — the
 * `sidechat-ooc` kind's wiring of the generic {@link AgentCompactionService},
 * the way `ScriptAgentCompactionService` is the `script` kind's. The generic
 * mechanism (budget trim, digest boundary, echo stubs, token estimate,
 * persistence) is shared; what is injected here is the sidechat's OWN turn
 * knowledge:
 *
 * - the SUMMARIZER PROMPT is SC-8b's `sidechat_ooc_digest` service prompt
 *   through SC-8a's ladder (the active service-prompt profile's override,
 *   else the `agent-sidechat/ooc-digest.md` asset) — the digest records what
 *   was DISCUSSED about the story, never the story itself;
 * - the KEEP BOUNDARY never cuts a question from its answer: the shell's
 *   `findSafeCompactionBoundary` is tool-pair-safe but blind to OOC
 *   alternation, so `refineKeepBoundary` walks the cursor back off an
 *   assistant head — a user message and its reply are summarized together or
 *   kept together, never split across the digest;
 * - the SUMMARIZER TRANSCRIPT carries the summarized span's frozen RP events
 *   interleaved by `seq`, marked `[rp-reference]`, beside the OOC rows —
 *   without them «what do you think of this swipe?» summarizes to nothing
 *   (review note 2026-10-20). The span runs from the PRIOR digest's anchor
 *   (else the timeline start) up to the new keep boundary, so consecutive
 *   digests' reference coverage is disjoint and gap-free; the events are
 *   REFERENCE ONLY — they never leave the model window as flow rows and the
 *   digest prompt forbids restating them;
 * - the AUTO rule (autoCompactAfterSidechatTurn) measures the DISCUSSION
 *   (digest + OOC rows) against the room left after the static context and
 *   the RP layer, reusing the shell's {@link AUTO_COMPACT_THRESHOLD} (80 %) —
 *   never a new number. The shell's whole-budget rule would fire after every
 *   exchange once the RP layer fills the budget (compacting the discussion
 *   cannot shrink the RP layer) — a paid model call per turn; here the
 *   pressure is computed by the kind's assembly each turn
 *   (`SidechatAssembledPrompt.autoCompactPressure`) and handed in by the
 *   stream's wiring.
 */

import type {
	AgentThreadTimelineEntry,
	AppDb,
	ExperienceCopilotMessage,
	ExperienceCopilotStore,
} from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { AttachmentAssetLoader } from "../../infrastructure/ai/vision-gate.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import {
	AgentCompactionService,
	AUTO_COMPACT_THRESHOLD,
	type AgentCompactionStore,
} from "../agent/agent-compaction.js";
import { storeMessagesToHistory } from "../agent/agent-stream.js";
import {
	stubHistoricalToolEchoes,
	type AgentFlowMessage,
} from "../agent/agent-prompt.js";
import { resolveServicePromptText } from "../service-prompts/service-prompt-resolver.js";
import { getServicePromptAssetFile } from "../service-prompts/service-prompt-registry.js";
import { mapTimelineEvent } from "./sidechat-context.js";
import { renderTimelineEvent } from "./sidechat-xml.js";
import {
	COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
	COPILOT_COMPACT_TEMPERATURE,
} from "../interactive/copilot/copilot-limits.js";

/** The store the sidechat compaction reads: the generic mechanism's subset
 *  PLUS the merged timeline (SC-1) — the transcript's reference events and
 *  their interleaving come from it. The concrete `ExperienceCopilotStore`
 *  satisfies this structurally. */
export type SidechatCompactionStore = AgentCompactionStore<ExperienceCopilotMessage> &
	Pick<ExperienceCopilotStore, "listTimeline">;

/** The auto-compaction pressure the sidechat's assembly derives each turn
 *  (SC-8c): how many tokens the DISCUSSION occupies (digest + OOC rows) and
 *  how much room is LEFT after the static context (system + attached) and the
 *  RP layer — the two things compacting the discussion cannot shrink. */
export interface SidechatAutoCompactPressure {
	readonly discussionTokens: number;
	readonly roomTokens: number;
}

/** The line prefix that marks a frozen RP event as REFERENCE material in the
 *  summarizer transcript (the digest prompt tells the model the RP material
 *  is reference, never digest material — this prefix makes those rows
 *  identifiable beside the OOC rows). */
const RP_REFERENCE_PREFIX = "[rp-reference]";

/** Timeline `seq` as a comparable number: pre-SC-1 NULL-seq rows sort first,
 *  so null maps to negative infinity (the same order listTimeline uses). */
function seqOf(row: AgentThreadTimelineEntry): number {
	return row.seq ?? Number.NEGATIVE_INFINITY;
}

/** Build the sidechat's summarizer transcript: the replaced OOC rows (the
 *  shell's stubbed flow conversion — the sidechat carries no tools today, so
 *  the stubbing is a no-op by construction) with the summarized span's frozen
 *  RP events interleaved by `seq` as `[rp-reference]` user rows. The span runs
 *  from the PRIOR digest's anchor (the first replaced row — consecutive
 *  digests' coverage is disjoint and gap-free) or the timeline start, up to
 *  the new keep boundary (exclusive: events of the verbatim tail still ride
 *  the model window and are never the summarizer's material). Digest rows on
 *  the timeline never render — the prior digest's TEXT rides the transcript
 *  as the shell's «Prior compacted context» section, not as a row. */
async function buildSidechatSummarizerTranscript(
	store: SidechatCompactionStore,
	threadId: string,
	input: {
		readonly toSummarize: readonly ExperienceCopilotMessage[];
		readonly keepFirst: ExperienceCopilotMessage | null;
		readonly hadPriorDigest: boolean;
	},
): Promise<AgentFlowMessage[]> {
	const stubbed = stubHistoricalToolEchoes(
		storeMessagesToHistory(input.toSummarize).filter(
			(m): m is AgentFlowMessage => m.role !== "digest",
		),
		{ keepUserTurns: 0 },
	);
	const flowById = new Map<string, AgentFlowMessage>();
	input.toSummarize.forEach((row, index) => flowById.set(row.id, stubbed[index]!));

	const spanStart = input.hadPriorDigest
		? input.toSummarize[0]!.seq ?? Number.NEGATIVE_INFINITY
		: Number.NEGATIVE_INFINITY;
	const spanEnd = input.keepFirst !== null
		? input.keepFirst.seq ?? Number.POSITIVE_INFINITY
		: Number.POSITIVE_INFINITY;

	const timeline = await store.listTimeline(threadId);
	const transcript: AgentFlowMessage[] = [];
	for (const entry of timeline) {
		const seq = seqOf(entry);
		if (seq < spanStart || seq >= spanEnd) continue;
		if (entry.rowType === "message") {
			// Digest rows ride the shell's «Prior compacted context» section,
			// never the transcript's own rows.
			if (entry.role === "digest") continue;
			const flow = flowById.get(entry.id);
			if (flow === undefined) {
				// The span's message rows ARE the replaced set (both reads come
				// from the same table; rows cannot be deleted) — a miss is
				// corruption, and silently skipping would change what the
				// summarizer is shown. Same refusal family as the loader's.
				throw new Error(
					`buildSidechatSummarizerTranscript: thread ${threadId} message ${entry.id} sits inside the summarized span but is not one of the replaced rows — refusing to build a mismatched transcript`,
				);
			}
			transcript.push(flow);
			continue;
		}
		transcript.push({
			role: "user",
			content: `${RP_REFERENCE_PREFIX} ${renderTimelineEvent(mapTimelineEvent(threadId, entry))}`,
		});
	}
	return transcript;
}

/** The sidechat wiring of the generic {@link AgentCompactionService}: same
 *  constructor surface (store / provider profiles / injectable executor /
 *  optional db unlocking the service-prompt override tier) as the script
 *  kind's twin, with the sidechat's own seams — the `sidechat_ooc_digest`
 *  prompt ladder, the question/answer-safe boundary refinement, and the
 *  reference-event transcript. */
export class SidechatOocCompactionService extends AgentCompactionService<ExperienceCopilotMessage> {
	constructor(
		private readonly sidechatStore: SidechatCompactionStore,
		providerProfiles: ProviderProfileService,
		execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
		db?: AppDb,
		attachmentAssetLoader?: AttachmentAssetLoader,
	) {
		super(sidechatStore, providerProfiles, execute, {
			attachmentAssetLoader,
			storeMessagesToFlow: storeMessagesToHistory,
			// SC-8a ladder over SC-8b's key: the active service-prompt
			// profile's override first, else the bundled asset.
			resolveSystemPrompt: () =>
				db
					? resolveServicePromptText(db, "sidechat_ooc_digest")
					: loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_digest")),
			overrideTemperature: COPILOT_COMPACT_TEMPERATURE,
			overrideMaxTokens: COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
			threadLabel: "ExperienceCopilotThread",
			logChannelPrefix: "api.sidechat-ooc",
			// SC-8c: the keep side never starts on an assistant reply — walk
			// the cursor back so a question and its answer are folded or kept
			// together. The walk only moves toward 0 (a thread whose whole
			// keep side is assistant rows walks to 0 and the compaction skips).
			refineKeepBoundary: (flow, cursor) => {
				let refined = cursor;
				while (refined > 0 && flow[refined] !== undefined && flow[refined]!.role === "assistant") {
					refined -= 1;
				}
				return refined;
			},
			// SC-8c: the summarizer sees what was discussed — the span's
			// frozen RP events as reference rows beside the OOC rows.
			buildSummarizerTranscript: (input) =>
				buildSidechatSummarizerTranscript(sidechatStore, input.threadId, input),
		});
	}

	/** SC-8c fire-and-forget auto-compaction, the sidechat twin of the shell's
	 *  `autoCompactAfterTurn` (deliberately NOT an override: the shell's
	 *  signature carries no pressure, and the sidechat rule cannot read it
	 *  from `contextMetrics` — the RP layer and the discussion share the
	 *  history segment there). The gate reuses the shell's threshold on the
	 *  DISCUSSION against the room left after the static context and the RP
	 *  layer:
	 *  - no room left (static + RP layer alone fill the budget) → skip:
	 *    compacting the discussion frees nothing durable, and after it the
	 *    regrown digest would re-fire EVERY turn — the exact paid-call loop
	 *    this rule exists to prevent;
	 *  - discussion ≥ 80 % of the room → run (the generic locked runner:
	 *    per-thread lock, skip-on-empty, errors logged never thrown).
	 *  The toggle and last-used-pair checks are the shell's own. */
	async autoCompactAfterSidechatTurn(
		threadId: string,
		pressure: SidechatAutoCompactPressure,
	): Promise<void> {
		const thread = await this.sidechatStore.getById(threadId);
		if (!thread) return;
		if (!thread.autoCompact) return;
		// No last-used pair → the service cannot resolve a provider/model → skip.
		if (!thread.lastProviderProfileId || !thread.lastModel) return;
		// The room must be positive for the fraction to mean anything (see the
		// doc comment: a non-positive room must skip, never fire).
		if (!(pressure.roomTokens > 0)) return;
		if (!(pressure.discussionTokens >= AUTO_COMPACT_THRESHOLD * pressure.roomTokens)) return;

		await this.runAutoCompaction(threadId, thread.lastProviderProfileId, thread.lastModel);
	}
}
