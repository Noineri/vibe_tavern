/**
 * IR-41 (Wave 4): pure construction + deterministic budget reduction for the
 * frozen RP context fed to an experience model-controlled seat.
 *
 * NO I/O. The service layer (`experience-context-service`, IR-42) resolves WHICH
 * messages/summaries/snapshots to pass per the active `ExperienceContextMode`
 * (none | current_branch | recent | summaries_recent | compact_summary); this
 * module only CONSTRUCTS the immutable bundle from resolved inputs and trims the
 * oldest optional RP material to fit a budget, reusing the same tool-pair-safe
 * compaction planner the chat pipeline uses (`planHistoryCompaction`).
 *
 * Privacy invariant (SCRIPTED_GAMES_DESIGN "Hidden information"): this module
 * never sees hidden authoritative state — the caller passes only already-
 * projected PUBLIC RP material. Per-seat private views are a separate input to
 * the model-prompt builder (`experience-model-prompt.ts`), never folded into the
 * shared context bundle. The bundle is therefore safe to hand to any model seat.
 *
 * Budget reduction order (deterministic):
 *   1. Character/persona snapshots + summaries are RESERVED — high-value,
 *      low-volume, never trimmed.
 *   2. RP history messages are trimmed OLDEST FIRST (a trailing suffix is kept).
 *   3. The boundary is tool-pair-safe (`findSafeCompactionBoundary`): an
 *      assistant tool-call and its tool-result are never split.
 *   4. At least 2 recent messages are always preserved (matches the chat
 *      pipeline's `minPreservedMessages`).
 */
import {
	estimateTokens,
	planHistoryCompaction,
} from "./compaction.js";

// ─── Input material ──────────────────────────────────────────────────────────

/** One frozen RP message, already resolved to its SELECTED variant by the
 *  service. The pure builder never resolves variants — it only constructs +
 *  budgets from what it is given. */
export interface ExperienceContextMessage {
	id: string;
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** Selected variant id this content was resolved from (traceability only). */
	variantId?: string;
}

/** An existing included summary. High-value, low-volume — never trimmed. */
export interface ExperienceContextSummary {
	id: string;
	content: string;
	label?: string;
}

/** Character identity snapshot. Reserved (never trimmed). */
export interface ExperienceContextCharacter {
	id: string;
	name: string;
	description: string;
	scenario?: string | null;
	personality?: string | null;
}

/** Persona identity snapshot. Reserved (never trimmed). */
export interface ExperienceContextPersona {
	id: string;
	name: string;
	description: string;
}

/** Budget for the frozen bundle. When omitted, the bundle is constructed
 *  verbatim with no trimming (the caller opts out of budget reduction). */
export interface ExperienceBudget {
	contextBudget: number;
	responseReserve: number;
	model?: string;
}

export interface ExperienceContextInput {
	/** Frozen alternating branch messages, oldest→newest, each already resolved
	 *  to its selected variant. This is the only material eligible for trimming. */
	messages: ReadonlyArray<ExperienceContextMessage>;
	/** Existing included summaries, oldest→newest. */
	summaries?: ReadonlyArray<ExperienceContextSummary>;
	character?: ExperienceContextCharacter | null;
	persona?: ExperienceContextPersona | null;
	budget?: ExperienceBudget | null;
}

// ─── Output bundle ───────────────────────────────────────────────────────────

export interface ExperienceContextTokenAccounting {
	messages: number;
	summaries: number;
	character: number;
	persona: number;
	/** Reserved (character + persona + summaries) + preserved messages. */
	total: number;
}

export interface ExperienceContextBundle {
	/** Preserved messages, oldest→newest, tool-pair-safe, budget-trimmed. */
	messages: ExperienceContextMessage[];
	/** Summaries, unchanged (never trimmed). */
	summaries: ExperienceContextSummary[];
	character: ExperienceContextCharacter | null;
	persona: ExperienceContextPersona | null;
	tokenAccounting: ExperienceContextTokenAccounting;
	/** Oldest messages dropped by budget reduction (empty when no trimming). */
	droppedMessages: Array<{ id: string; reason: string }>;
	/** Human-readable compaction note for the trace UI; `null` when nothing was
	 *  trimmed. Not sent to the model. */
	compactionSummary: string | null;
}

// ─── Snapshot text rendering ─────────────────────────────────────────────────
// Pure render of the identity snapshots into the text the model sees. Kept here
// (not in the model-prompt builder) so the token accounting in the bundle uses
// the SAME text the builder later renders — the numbers stay truthful.

export function characterSnapshotText(character: ExperienceContextCharacter): string {
	const parts: string[] = [`Character: ${character.name}`];
	if (character.description) parts.push(character.description);
	if (character.scenario) parts.push(`Scenario: ${character.scenario}`);
	if (character.personality) parts.push(`Personality: ${character.personality}`);
	return parts.join("\n");
}

export function personaSnapshotText(persona: ExperienceContextPersona): string {
	return `User persona (${persona.name}): ${persona.description}`;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildExperienceContext(
	input: ExperienceContextInput,
): ExperienceContextBundle {
	const allMessages: ExperienceContextMessage[] = [...input.messages];
	const summaries = [...(input.summaries ?? [])];
	const character = input.character ?? null;
	const persona = input.persona ?? null;

	const characterTokens = character ? estimateTokens(characterSnapshotText(character)) : 0;
	const personaTokens = persona ? estimateTokens(personaSnapshotText(persona)) : 0;
	const summaryTokens = summaries.reduce((sum, s) => sum + estimateTokens(s.content), 0);
	// Reserved = non-history material that must fit and is never trimmed.
	const reservedTokens = characterTokens + personaTokens + summaryTokens;

	const countHistoryTokens = (msgs: ReadonlyArray<ExperienceContextMessage>): number =>
		msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

	const budget = input.budget;
	const plan =
		budget && budget.contextBudget > 0
			? planHistoryCompaction({
					messages: allMessages,
					nonHistoryTokens: reservedTokens,
					contextBudget: budget.contextBudget,
					responseReserve: budget.responseReserve,
					countHistoryTokens,
					minPreservedMessages: 2,
				})
			: null;

	let preserved: ExperienceContextMessage[];
	let dropped: Array<{ id: string; reason: string }>;
	let compactionSummary: string | null;

	if (plan) {
		// planHistoryCompaction returns the preserved suffix + its token count;
		// the dropped prefix is everything before it.
		preserved = plan.messages;
		const preservedIds = new Set(preserved.map((m) => m.id));
		dropped = allMessages
			.filter((m) => !preservedIds.has(m.id))
			.map((m) => ({ id: m.id, reason: "context_budget" }));
		const droppedCount = allMessages.length - preserved.length;
		compactionSummary =
			droppedCount > 0
				? `Experience context budget ${budget!.contextBudget} exceeded; dropped ${droppedCount} oldest RP message(s) (tool-pair-safe, ≥2 preserved) to fit.`
				: null;
	} else {
		preserved = allMessages;
		dropped = [];
		compactionSummary = null;
	}

	const messageTokens = countHistoryTokens(preserved);

	return {
		messages: preserved,
		summaries,
		character,
		persona,
		tokenAccounting: {
			messages: messageTokens,
			summaries: summaryTokens,
			character: characterTokens,
			persona: personaTokens,
			total: reservedTokens + messageTokens,
		},
		droppedMessages: dropped,
		compactionSummary,
	};
}
