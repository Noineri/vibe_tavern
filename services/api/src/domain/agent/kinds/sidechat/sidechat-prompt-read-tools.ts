/**
 * The sidechat-OOC kind's reply-prompt read tool (SIDECHAT_PLAN Wave 5b /
 * SC-23e) — `read_message_prompt`, the kind's PERMISSION tool and the second
 * "waits for the user" family after `ask_user`: the RP prompt is the USER's
 * material, so the model may not silently read it. The tool's execute NEVER
 * returns prompt text — it resolves the reply (its branch position + optional
 * variant number), finds the trace SC-23b linked to that swipe, renders the
 * trace's frozen final payload through the shared RP prompt view
 * (rp-prompt-view.ts — SC-23c's one renderer, both arms) against the
 * sidechat's CURRENT held set, and returns the AWAITING-PERMISSION marker
 * carrying everything the user's card renders: the reply's first line, the
 * variant number, the preset name, and the ~N-token estimate of the exact
 * text. The generic loop stops the turn on the call (the kind's
 * `waitToolNames` seam); the user's decision arrives as a new answer variant
 * `{ toolCallId, decision }` — allow runs {@link runGrantedPromptRead} (the
 * SAME resolution, returning the real `<rp_prompt>` view) and the loop stores
 * its result in the awaiting row; deny stores `{ status: "denied" }`.
 *
 * THE NO-GUESS RULE (SC-23b): a reply whose variant has no linked trace — a
 * swipe from before SC-23b, a NULL variant_id, a trace deleted with its
 * message — has an UNKNOWN exact prompt. The tool answers that honestly
 * (never a marker, never a time-based reconstruction) and the turn does NOT
 * stop: there is nothing to reveal, so there is nothing to ask permission
 * for.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { isRecord, log, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { MessageStore, PromptTraceStore } from "@vibe-tavern/db";
import { estimateTokens } from "@vibe-tavern/prompt-pipeline";
import { validation } from "../../../../shared/errors.js";
import { mapFinalPayloadMessages } from "../../../sidechat/sidechat-context.js";
import {
	renderRpPromptView,
	type RpPromptViewLayer,
} from "../../../sidechat/rp-prompt-view.js";

/** Same observability discipline as the other sidechat tools (CA-17/CANARY):
 *  without the IN/OK lines a sidechat tool call is invisible server-side. */
const logger = log.tag("sidechat.tool");

/** The tool's wire name — the `SIDECHAT_OOC_TOOL_KEYS` toggle key, the
 *  `waitToolNames` stop entry, and the `toolName` the persisted marker row
 *  carries. The one spelling the stream's gating and the split-turn rows
 *  read. */
export const SIDECHAT_PROMPT_READ_TOOL_NAME = "read_message_prompt";

/** The tool's input contract: the reply's branch position (the number the
 *  frozen `<rp_message position=…>` rows carry) plus the OPTIONAL variant
 *  number — the `<variant number=…>` value, i.e. `variantIndex + 1`. An
 *  absent `variant` means the message's currently SELECTED swipe. Exported so
 *  the granted re-run validates the RECORDED input through the same schema
 *  the loop enforced on the original call. */
export const sidechatPromptReadInputSchema = z.object({
	position: z
		.number()
		.int()
		.min(0)
		.describe("The reply's branch position — the number in <rp_message position=…>."),
	variant: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("The swipe's number from <variant number=…>. Omit for the currently selected swipe."),
});

export type SidechatPromptReadInput = z.infer<typeof sidechatPromptReadInputSchema>;

// ─── Result shapes (the persisted tool-row outputs) ──────────────────────────

/** The awaiting marker (SC-23e): everything the user's card renders — the
 *  reply identified by its first line, the variant number, the preset name
 *  and the ≈N-token estimate of the exact prompt text — so the card needs no
 *  second fetch. Stored state for the UI; the model reads the wire rendering
 *  (agent-split-turn.ts), never this marker JSON. */
export interface SidechatPromptReadMarkerResult {
	readonly status: "awaiting_permission";
	/** The reply's branch position (the tool input, echoed for the card). */
	readonly position: number;
	/** The RP UI's variant number (`variantIndex + 1`). */
	readonly variantNumber: number;
	/** The reply's first line — how the user recognizes the swipe. */
	readonly replyFirstLine: string;
	/** The ≈N-token estimate of the exact rendered prompt text. */
	readonly promptTokens: number;
	/** The preset name the trace froze (the reply's provenance). */
	readonly presetName: string;
}

/** The granted result (the allow path's REAL output, stored in the awaiting
 *  row): the full `<rp_prompt>` view of the exact prompt the reply's trace
 *  froze — preset blocks and custom injects in full, held material as
 *  placeholders — plus its token count. */
export interface SidechatPromptReadGrantedResult {
	readonly status: "granted";
	readonly prompt: string;
	readonly promptTokens: number;
	readonly position: number;
	readonly variantNumber: number;
	readonly presetName: string;
}

/** The no-guess answer (SC-23b): the reply resolved but its exact prompt was
 *  never recorded — returned directly by the tool (nothing to ask about) and
 *  re-returned by the granted re-run if the link vanished before the allow. */
export interface SidechatPromptReadUnknownResult {
	readonly status: "unknown_prompt";
	readonly position: number;
	/** Null when the variant itself no longer resolves at answer time. */
	readonly variantNumber: number | null;
	readonly note: string;
}

/** The model-facing "your reference did not resolve" answer (a position
 *  beyond the branch, a variant number the message does not carry) — the
 *  model self-corrects its reference; never a permission request. */
export interface SidechatPromptReadUnresolvedResult {
	readonly status: "unresolved";
	readonly note: string;
}

// ─── Dependencies + turn state ───────────────────────────────────────────────

/** The stores the resolution reads — `Pick`s so tests and callers pass narrow
 *  seams (the stream wires its context-deps picks: the same store seam the
 *  loader reads, one wiring). */
export interface SidechatPromptReadDeps {
	readonly messages: Pick<MessageStore, "getMessages" | "getVariantsByBranch">;
	readonly traces: Pick<PromptTraceStore, "getTraceByVariant">;
}

/** The per-turn state the resolution runs against: the THREAD ROW's own chat
 *  + branch (never the request) and the sidechat's CURRENT held lore set
 *  (the context loader's one derivation — the same set its `active_lore`
 *  section rendered this turn). */
export interface SidechatPromptReadTurnState {
	readonly chatId: ChatId;
	readonly branchId: ChatBranchId;
	readonly heldLoreEntryIds: ReadonlySet<string>;
}

// ─── The one resolution (the marker, the grant, and the unknown all read it) ─

/** The resolution's outcomes: the view (a linked trace, rendered), the
 *  honest unknown (no link — the no-guess rule), or an unresolved reference
 *  (bad position / variant). */
type ResolvedReplyPrompt =
	| { kind: "view"; view: string; promptTokens: number; position: number; variantNumber: number; replyFirstLine: string; presetName: string }
	| { kind: "unknown"; position: number; variantNumber: number; note: string }
	| { kind: "unresolved"; note: string };

/** The unknown-prompt note — one wording, both callers (the direct answer and
 *  the granted re-run). */
const UNKNOWN_PROMPT_NOTE =
	"the exact prompt of this reply is not recorded — this swipe predates prompt tracing or its trace is gone; " +
	"reconstructing it from a nearby prompt by time would only guess";

/** Resolve one reply's exact prompt view: position → message → variant (the
 *  named number or the selected swipe) → the trace SC-23b linked to that
 *  variant → the stored payload + layers rendered through the shared RP
 *  prompt view against the sidechat's current held set. Pure read — no store
 *  writes; the token count is the server's own estimator (`estimateTokens`,
 *  the same source the context meter and trace UI count with), never a
 *  provider claim. */
async function resolveReplyPromptView(
	deps: SidechatPromptReadDeps,
	state: SidechatPromptReadTurnState,
	input: SidechatPromptReadInput,
): Promise<ResolvedReplyPrompt> {
	const branchMessages = await deps.messages.getMessages(state.branchId);
	const message = branchMessages.find((row) => row.position === input.position);
	if (message === undefined) {
		return { kind: "unresolved", note: `no message at position ${input.position} in this branch` };
	}
	const variantsByMessage = await deps.messages.getVariantsByBranch(state.branchId);
	const variants = variantsByMessage.get(message.id) ?? [];
	const variant =
		input.variant !== undefined
			? variants.find((row) => row.variantIndex === input.variant! - 1)
			: variants.find((row) => row.isSelected);
	if (variant === undefined) {
		return input.variant !== undefined
			? { kind: "unresolved", note: `message at position ${input.position} has no variant number ${input.variant}` }
			: { kind: "unresolved", note: `message at position ${input.position} has no selected swipe` };
	}
	const variantNumber = variant.variantIndex + 1;

	// SC-23b's no-guess rule: no linked trace → the exact prompt is UNKNOWN.
	const trace = await deps.traces.getTraceByVariant(state.chatId, state.branchId, variant.id);
	if (trace === null) {
		return { kind: "unknown", position: input.position, variantNumber, note: UNKNOWN_PROMPT_NOTE };
	}

	const positionByMessageId = new Map(branchMessages.map((row) => [row.id, row.position]));
	const view = renderRpPromptView({
		presetName: trace.presetName,
		messages: mapFinalPayloadMessages(trace.finalPayload, positionByMessageId, `trace ${trace.id}`),
		layers: narrowTraceLayers(trace.assembledLayers),
		heldLoreEntryIds: state.heldLoreEntryIds,
	});
	if (view === null) {
		// A trace whose frozen payload carries no messages: there is no exact
		// prompt text to show — the honest unknown, never an empty "grant".
		return { kind: "unknown", position: input.position, variantNumber, note: UNKNOWN_PROMPT_NOTE };
	}
	return {
		kind: "view",
		view,
		promptTokens: estimateTokens(view),
		position: input.position,
		variantNumber,
		replyFirstLine: firstLine(variant.content),
		presetName: trace.presetName,
	};
}

/** Narrow a stored trace's `assembledLayers` (plain JSON) onto the view's
 *  layer input. A malformed row is SKIPPED, not thrown: the view then treats
 *  any payload entry referencing it as not-held and shows it in full — the
 *  safe direction for a permission read (never hides prompt text, never
 *  guesses an attribution). */
function narrowTraceLayers(layers: readonly unknown[]): RpPromptViewLayer[] {
	const narrowed: RpPromptViewLayer[] = [];
	for (const layer of layers) {
		if (
			!isRecord(layer) ||
			typeof layer.id !== "string" ||
			typeof layer.sourceType !== "string" ||
			typeof layer.sourceId !== "string" ||
			typeof layer.sourceName !== "string"
		) {
			continue;
		}
		narrowed.push({
			id: layer.id,
			sourceType: layer.sourceType,
			sourceId: layer.sourceId,
			sourceName: layer.sourceName,
			...(typeof layer.injectionDepth === "number" ? { injectionDepth: layer.injectionDepth } : {}),
		});
	}
	return narrowed;
}

/** The reply's first line — how the user's card names the swipe. The STORED
 *  variant content's first line (what the RP chat shows), never a
 *  transformation of it. */
function firstLine(content: string): string {
	const newline = content.indexOf("\n");
	return newline === -1 ? content : content.slice(0, newline);
}

// ─── The marker-returning tool + the granted re-run ─────────────────────────

/** Render the resolution as the tool's direct (non-permission) answer. */
function directAnswerOf(
	resolved: ResolvedReplyPrompt,
):
	| SidechatPromptReadMarkerResult
	| SidechatPromptReadUnknownResult
	| SidechatPromptReadUnresolvedResult {
	if (resolved.kind === "view") {
		return {
			status: "awaiting_permission",
			position: resolved.position,
			variantNumber: resolved.variantNumber,
			replyFirstLine: resolved.replyFirstLine,
			promptTokens: resolved.promptTokens,
			presetName: resolved.presetName,
		};
	}
	if (resolved.kind === "unknown") {
		return { status: "unknown_prompt", position: resolved.position, variantNumber: resolved.variantNumber, note: resolved.note };
	}
	return { status: "unresolved", note: resolved.note };
}

/**
 * Build the sidechat's `read_message_prompt`. `toolSet` is the RESOLVED
 * profile's set (the kind's toggles, SC-5/SC-23e): the tool is served only
 * when `read_message_prompt` is enabled — the toggle gates AVAILABILITY, never
 * the permission (every call asks, even with the toggle on). `state` is the
 * turn's own chat + branch + held set (captured by the stream's buildTools
 * seam from the context the loader just returned).
 */
export function buildSidechatPromptReadTools(input: {
	readonly toolSet: Record<string, boolean>;
	readonly deps: SidechatPromptReadDeps;
	readonly state: SidechatPromptReadTurnState;
}): ToolSet {
	const allTools = {
		[SIDECHAT_PROMPT_READ_TOOL_NAME]: tool({
			description:
				"Read the exact RP prompt that produced one reply — WITH THE USER'S PERMISSION. " +
				"Input: the reply's `position` (the number in <rp_message position=…>), plus the `variant` number from <variant number=…> when the user means a specific swipe; omit `variant` for the currently selected swipe. " +
				"The RP prompt is the user's material — this call never reads it silently: each call first asks the user, the turn pauses on the request, and only if the user allows do you receive the prompt (as <rp_prompt>: preset blocks and custom injects in full, the card/persona/lore/history you already hold as placeholders). " +
				"Use it when the user asks how a reply was written (for example: by which prompt was this swipe made?). " +
				"A reply whose exact prompt was not recorded answers unknown_prompt — say so honestly; never reconstruct a prompt by time or guessing. " +
				"If the user denies, continue the turn without the prompt and do not ask again for the same reply.",
			inputSchema: sidechatPromptReadInputSchema,
			execute: async (parsed, options): Promise<
				SidechatPromptReadMarkerResult | SidechatPromptReadUnknownResult | SidechatPromptReadUnresolvedResult
			> => {
				logger.info(
					"read_message_prompt IN position=%d variant=%s callId=%s",
					parsed.position,
					parsed.variant ?? "(selected)",
					options.toolCallId,
				);
				const resolved = await resolveReplyPromptView(input.deps, input.state, parsed);
				const result = directAnswerOf(resolved);
				logger.info(
					"read_message_prompt OK status=%s tokens=%s",
					result.status,
					result.status === "awaiting_permission" ? result.promptTokens : "-",
				);
				return result;
			},
		}),
	};

	// The kind's toggles (the resolved profile's set): only enabled keys are
	// served — the same filter the other sidechat tool families apply.
	return Object.fromEntries(
		Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
	) as typeof allTools;
}

/**
 * The granted re-run (the allow half of the SC-23e permission answer): the
 * SAME resolution the marker came from, returning the REAL result the
 * awaiting row stores. A view that vanished between the ask and the allow
 * (the reply deleted, the link gone) degrades to the honest unknown — never
 * a denial the user did not choose and never a guess. The input is the
 * RECORDED tool-call input, validated through the tool's own schema before
 * any store read.
 *
 * @throws the typed validation when the recorded input is not the tool's
 *   input shape (a corrupted row — refused, never re-run on guessed args).
 */
export async function runGrantedPromptRead(
	deps: SidechatPromptReadDeps,
	state: SidechatPromptReadTurnState,
	recordedInput: unknown,
): Promise<SidechatPromptReadGrantedResult | SidechatPromptReadUnknownResult> {
	const parsed = sidechatPromptReadInputSchema.safeParse(recordedInput);
	if (!parsed.success) {
		throw validation(
			"The recorded read_message_prompt input is not the tool's input shape — refusing to re-run it.",
		);
	}
	const resolved = await resolveReplyPromptView(deps, state, parsed.data);
	if (resolved.kind === "view") {
		return {
			status: "granted",
			prompt: resolved.view,
			promptTokens: resolved.promptTokens,
			position: resolved.position,
			variantNumber: resolved.variantNumber,
			presetName: resolved.presetName,
		};
	}
	// Unknown or unresolved at answer time — the exact prompt can no longer be
	// produced; the honest unknown (the no-guess rule), never a denial.
	return {
		status: "unknown_prompt",
		position: parsed.data.position,
		variantNumber: resolved.kind === "unknown" ? resolved.variantNumber : null,
		note: resolved.kind === "unknown" ? resolved.note : `the reply no longer resolves: ${resolved.note}`,
	};
}
