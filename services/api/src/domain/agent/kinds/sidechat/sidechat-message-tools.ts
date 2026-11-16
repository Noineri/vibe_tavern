/**
 * The sidechat Director's MESSAGE tools (DIRECTOR_MESSAGE_TOOLS_PLAN Wave 2 /
 * DMT-21) — `propose_message_edit`, `propose_message_variant` and
 * `request_message_swipe`, the three toggles the DMT-11 contract names. The
 * Director never writes an RP message itself: the first two tools produce
 * ordinary PENDING `RecordProposal`s the user reviews (Apply/Save or Reject
 * through the one record-proposal registry, DMT-22), and the third is the
 * split-turn PERMISSION tool whose `awaiting_permission` marker stops the
 * turn until the user decides (DMT-23 runs the allowed regeneration).
 *
 * `propose_message_edit({ position, variant?, instruction })` — the
 * mechanical-correction proposal: resolve the target (the thread branch's
 * committed assistant reply + swipe, {@link DirectorMessageTargetRef
 * refusals are precise}), delegate generation to the DMT-14 editor delegate
 * (the ordinary `message_edit` task — the ONLY difference is the
 * instruction author), and freeze the candidate + the delegate's ACTUAL
 * provenance into a `message-edit` proposal whose diff base is the source
 * swipe's stored text. No Apply here, no editor prompt copy, no
 * Director-model fallback: an unconfigured editor is a model-relayed
 * failure, never a crash and never a different model.
 *
 * `propose_message_variant({ position, sourceVariants, content })` — the
 * Director's OWN alternative reply: the complete text the model passes is
 * the candidate (NO second LLM call, no merge/synthesis — one source is
 * valid, this is NOT the merge tool), frozen with the source swipes'
 * identities into a `message-variant` proposal. Save appends a separate
 * swipe later (DMT-22), never here.
 *
 * `request_message_swipe({ position, instruction })` — the regeneration
 * PERMISSION request: validate/capture the target and return the
 * `awaiting_permission` marker (the DMT-11 `directorSwipePermissionMarkerSchema`
 * shape: frozen identity + reply identification + the instruction IN FULL).
 * NO generation, NO variant append, NO selection, NO persisted RP
 * instruction — the draft lives only in the marker until the user approves
 * an edited-or-verbatim copy (DMT-23/24).
 *
 * Unresolvable inputs THROW the precise model-correctable note (the
 * `propose_plan` pattern — the loop surfaces the message as the call's
 * error result): the model can retry with fixed arguments, and the turn
 * does NOT stop on a permission request that has nothing to request for.
 * Delegate outcomes that produced no candidate (not configured, cancelled,
 * failed) return model-facing TEXT (the `propose_tracker_template`
 * pattern): relay or retry, never a proposal, never a marker.
 *
 * SERVED (DMT-23 wired the stream seam, DMT-34 landed the public toggles):
 * the stream spreads this builder at the profile-gated build seam beside
 * the stop condition, and DMT-34 added the three toggle keys to the wire
 * contract with the `builtin-director` seed enabling them (the OOC seed and
 * the kind default keep the keys off — the builder is complete and gated
 * here so that wiring touches no tool logic; the TAG-1 pattern, with keys
 * and implementation landing together).
 */

// fork #1 of sidechat-director-tools.ts
// (services/api/src/domain/agent/kinds/sidechat/sidechat-director-tools.ts —
// forks: 1 there) — the same builder skeleton. Correspondence: the
// allTools + per-key toolSet filter, the RecordProposal emission shape
// (`kind: "record"`, `id: toolCallId`, `status: "pending"`), the
// delegate-generation seam with the not-configured refusal, the IN/OK
// observability lines, and the model-facing failure TEXT for delegate
// outcomes. Deviations: THREE tools (edit + variant + swipe permission);
// the target resolution lives in the shared director-message-target.ts
// resolver; tool names + record types + payload/marker shapes come from the
// DMT-11 contract schemas (one source); the swipe tool returns the
// permission MARKER, not a proposal.

import { tool, type ToolSet } from "ai";
import type { MessageStore } from "@vibe-tavern/db";
import {
	DIRECTOR_MESSAGE_RECORD_TYPES,
	DIRECTOR_MESSAGE_TOOLS,
	proposeMessageEditInputSchema,
	proposeMessageVariantInputSchema,
	requestMessageSwipeInputSchema,
	type DirectorMessageEditProposal,
	type DirectorMessageVariantProposal,
	type DirectorSwipePermissionMarker,
	type RecordProposal,
} from "@vibe-tavern/api-contracts";
import { log } from "@vibe-tavern/domain";
import type {
	DirectorMessageEditorDelegateInput,
	DirectorMessageEditorDelegateResult,
} from "../../../director/director-message-editor-delegate.js";
import {
	directorMessageSourceIdentityOf,
	directorMessageTargetRefusalNote,
	resolveDirectorMessageSourceSet,
	resolveDirectorMessageTarget,
} from "../../../director/director-message-target.js";

/** Same observability discipline as the other sidechat tools (CA-17/CANARY):
 *  without the IN/OK lines a sidechat tool call is invisible server-side. */
const logger = log.tag("sidechat.tool");

/** The editor-delegate seam: the DMT-14 delegate with the host's deps bound
 *  (the tracker delegate's seam shape — the builder closes over the thread's
 *  own chat/branch pair and calls this per invocation). */
export type DirectorMessageEditorDelegateFn = (
	input: DirectorMessageEditorDelegateInput,
) => Promise<DirectorMessageEditorDelegateResult>;

/** What the builder needs beyond the resolved profile's toggles. `owner` is
 *  the THREAD ROW's own chat + branch pair (never the request, never the
 *  browser's active chat — the same row the other sidechat builders read);
 *  `messages` is the narrow resolution seam; `editorDelegate` is the ONE
 *  generation seam, bound by the host wiring (absent → the edit tool serves
 *  but refuses loudly at call time, the tracker delegate's seam shape). */
export interface SidechatMessageToolsInput {
	/** The RESOLVED profile's tool set (the kind's toggles): only enabled
	 *  keys are served — the same filter every sidechat builder applies. */
	readonly toolSet: Record<string, boolean>;
	/** The thread row's own chat + branch pair — the resolution scope and
	 *  the delegate's branch-pinned generation scope. */
	readonly owner: { readonly chatId: string; readonly branchId: string };
	/** The narrow message reads the target resolver runs through. */
	readonly messages: Pick<MessageStore, "getMessages" | "getVariantsByBranch">;
	/** The DMT-14 editor delegate with deps bound. Absent → invoking the
	 *  edit tool refuses loudly (a wiring gap, not a user state). */
	readonly editorDelegate?: DirectorMessageEditorDelegateFn;
}

/** The model-facing text for a delegate outcome that produced NO candidate —
 *  one arm per status, each telling the model what to do (relay or retry),
 *  never a proposal (the `propose_tracker_template` failure-text pattern). */
function editorDelegateFailureText(
	toolName: string,
	outcome: Exclude<DirectorMessageEditorDelegateResult, { status: "completed" }>,
): string {
	switch (outcome.status) {
		case "editor_not_configured":
			return (
				`${toolName}: no message editor is configured — tell the user to select a message editor provider first. ` +
				"Nothing was proposed."
			);
		case "cancelled":
			return `${toolName}: the correction was cancelled; nothing was proposed.`;
		case "failed":
			return (
				`${toolName}: the message editor generation failed: ${outcome.reason}. ` +
				"Please tell the user and ask whether they want to try again."
			);
	}
}

/** Build the Director's three message tools. Gated by the resolved profile's
 *  tool set exactly like the objective/checklist/director builders: a tool
 *  whose key is not enabled is not served. (The public toggle keys land in
 *  DMT-34; until then no stored profile can carry these keys.) */
export function buildSidechatMessageTools(input: SidechatMessageToolsInput): ToolSet {
	const allTools = {
		[DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]: tool({
			description:
				"Propose a small mechanical correction to one existing reply (names, poses, factual slips, wording) — " +
				"the rewrite is delegated to the ordinary message AI editor, WITH THE USER'S REVIEW BEFORE ANYTHING CHANGES. " +
				"Input: the reply's `position` (the number in <rp_message position=…>), the source swipe's `variant` number " +
				"from <variant number=…> (omit for the currently selected swipe), and `instruction`: the concrete, " +
				"self-contained correction for the editor (you write the instruction; the editor writes the replacement text). " +
				"The editor's candidate comes back as a PROPOSAL: the user reviews the diff and decides, and the reply changes " +
				"nothing until they apply it — never assume it was applied. " +
				"For an alternative reply written by yourself use `propose_message_variant`; for a fresh AI-generated swipe use `request_message_swipe`.",
			inputSchema: proposeMessageEditInputSchema,
			execute: async ({ position, variant, instruction }, options): Promise<RecordProposal | string> => {
				logger.info(
					"propose_message_edit IN position=%d variant=%s instructionLen=%d callId=%s",
					position,
					variant ?? "(selected)",
					instruction.length,
					options.toolCallId,
				);
				const resolved = await resolveDirectorMessageTarget(input.messages, input.owner.branchId, {
					position,
					...(variant !== undefined ? { variantNumber: variant } : {}),
				});
				if (!resolved.ok) {
					logger.warn("propose_message_edit REFUSED kind=%s callId=%s", resolved.refusal.kind, options.toolCallId);
					throw new Error(`propose_message_edit: ${directorMessageTargetRefusalNote(resolved.refusal)}`);
				}
				const target = resolved.target;
				if (!input.editorDelegate) {
					// The tracker delegate's seam shape: an unwired host serves the
					// tool but refuses loudly at call time.
					throw new Error("propose_message_edit: message editor generation is not configured");
				}
				const outcome = await input.editorDelegate({
					chatId: input.owner.chatId,
					branchId: input.owner.branchId,
					targetMessageId: target.messageId,
					sourceVariantId: target.variantId,
					instruction,
					signal: options.abortSignal,
				});
				if (outcome.status !== "completed") {
					logger.warn(
						"propose_message_edit NOT_COMPLETED status=%s callId=%s",
						outcome.status,
						options.toolCallId,
					);
					return editorDelegateFailureText("propose_message_edit", outcome);
				}
				const payload: DirectorMessageEditProposal = {
					source: directorMessageSourceIdentityOf(target),
					// The diff base is the SOURCE SWIPE's stored text — the exact
					// bytes the user's review diff draws against, never the
					// message row's selected content unless that swipe is selected.
					sourceText: target.text,
					instruction,
					candidate: outcome.candidate,
					editor: outcome.editor,
				};
				const proposal: RecordProposal = {
					kind: "record",
					id: options.toolCallId,
					recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
					op: "update",
					targetId: target.messageId,
					payload,
					status: "pending",
				};
				logger.info(
					"propose_message_edit OK id=%s candidateLen=%d model=%s",
					options.toolCallId,
					outcome.candidate.length,
					outcome.editor.modelId,
				);
				return proposal;
			},
		}),

		[DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant]: tool({
			description:
				"Propose YOUR OWN complete alternative reply for one existing exchange, saved as a separate swipe after the user's review — " +
				"this call makes NO AI generation: the text you pass is exactly what is proposed. " +
				"Input: the reply's `position` (the number in <rp_message position=…>), the `sourceVariants` numbers from " +
				"<variant number=…> your text is based on (at least one — usually the swipes you have seen), and `content`: " +
				"the FULL alternative reply text you write now. " +
				"The text comes back as a PROPOSAL: the user reviews it and decides, and a new swipe is added only when they save it — " +
				"never assume it was saved. " +
				"For a small mechanical fix by the editor use `propose_message_edit`; for asking the user to approve a regeneration use `request_message_swipe`.",
			inputSchema: proposeMessageVariantInputSchema,
			execute: async ({ position, sourceVariants, content }, options): Promise<RecordProposal> => {
				logger.info(
					"propose_message_variant IN position=%d sources=%d contentLen=%d callId=%s",
					position,
					sourceVariants.length,
					content.length,
					options.toolCallId,
				);
				// One resolution for the reply + every named source swipe — the
				// sources belong to THIS reply (the model based its text on the
				// swipes it saw). ONE source is valid; no merge/synthesis call
				// exists behind this tool.
				const resolved = await resolveDirectorMessageSourceSet(input.messages, input.owner.branchId, {
					position,
					variantNumbers: sourceVariants,
				});
				if (!resolved.ok) {
					logger.warn(
						"propose_message_variant REFUSED kind=%s callId=%s",
						resolved.refusal.kind,
						options.toolCallId,
					);
					throw new Error(`propose_message_variant: ${directorMessageTargetRefusalNote(resolved.refusal)}`);
				}
				const payload: DirectorMessageVariantProposal = {
					sources: resolved.sources.map(directorMessageSourceIdentityOf),
					content,
				};
				const proposal: RecordProposal = {
					kind: "record",
					id: options.toolCallId,
					recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
					op: "create",
					targetId: resolved.messageId,
					payload,
					status: "pending",
				};
				logger.info(
					"propose_message_variant OK id=%s sources=%d contentLen=%d",
					options.toolCallId,
					payload.sources.length,
					content.length,
				);
				return proposal;
			},
		}),

		[DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe]: tool({
			description:
				"Ask the user for permission to regenerate one reply as a fresh AI swipe — the turn PAUSES until they decide. " +
				"Input: the reply's `position` (the number in <rp_message position=…>) and `instruction`: your DRAFT one-shot " +
				"instruction for the new swipe, self-contained (the user can read and EDIT it before allowing). " +
				"Nothing is generated by this call and nothing changes: if the user allows, exactly one regeneration runs with " +
				"the final approved instruction and arrives as a normal new swipe; if they deny, continue the turn without it " +
				"and do not ask again for the same reply. " +
				"For a correction delegated to the message editor use `propose_message_edit`; for an alternative written by yourself use `propose_message_variant`.",
			inputSchema: requestMessageSwipeInputSchema,
			execute: async ({ position, instruction }, options): Promise<DirectorSwipePermissionMarker> => {
				logger.info(
					"request_message_swipe IN position=%d instructionLen=%d callId=%s",
					position,
					instruction.length,
					options.toolCallId,
				);
				const resolved = await resolveDirectorMessageTarget(input.messages, input.owner.branchId, { position });
				if (!resolved.ok) {
					logger.warn(
						"request_message_swipe REFUSED kind=%s callId=%s",
						resolved.refusal.kind,
						options.toolCallId,
					);
					// A model-correctable failure, NEVER a marker: an unresolved
					// target has nothing to ask permission for, so the turn must
					// not stop (the unit contract's refusal rule).
					throw new Error(`request_message_swipe: ${directorMessageTargetRefusalNote(resolved.refusal)}`);
				}
				const target = resolved.target;
				const marker: DirectorSwipePermissionMarker = {
					status: "awaiting_permission",
					messageId: target.messageId,
					variantId: target.variantId,
					position: target.position,
					variantNumber: target.variantNumber,
					replyFirstLine: target.replyFirstLine,
					// The DRAFT in full — the card renders and the user edits it;
					// it is request-local and persisted nowhere else.
					instruction,
				};
				logger.info(
					"request_message_swipe OK id=%s variantNumber=%d",
					options.toolCallId,
					target.variantNumber,
				);
				return marker;
			},
		}),
	};

	// The kind's toggles (the resolved profile's set): only enabled keys are
	// served — the same filter the objective/checklist/director builders apply.
	return Object.fromEntries(
		Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
	) as typeof allTools;
}
