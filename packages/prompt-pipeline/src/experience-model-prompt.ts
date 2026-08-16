/**
 * IR-41 (Wave 4): pure fixed-order prompt assembly for an experience
 * model-controlled seat, producing a normal `AssemblePromptResponse` ready for
 * the existing executor (`provider-executor-utils.toSdkMessages`).
 *
 * NO I/O. The service layer (`experience-model-effect-service`, IR-43) resolves
 * the provider/model, the per-session participant prompt, and the global /
 * character `experience_prompt_overrides`, then hands the resolved strings here.
 * This module only orders, token-counts, and (optionally) budget-trims.
 *
 * Fixed layer order (SCRIPTED_GAMES_DESIGN / plan output 2):
 *
 *   host protocol → package prompt → global override → character override →
 *     character/persona → context bundle (summaries + RP history) →
 *     private view/history
 *
 * Privacy invariant ("Hidden information"): the shared context bundle carries
 * only PUBLIC, already-projected RP material; the per-seat PRIVATE view + private
 * history are appended AFTER the shared context and are the ONLY hidden material
 * the model sees — exactly this seat's view, never another seat's. The private
 * view is emitted as the FINAL user message so the model answers it directly.
 *
 * Budget: the bundle may already be trimmed by `buildExperienceContext`, but that
 * trim does not know the framing / private-view overhead. This builder therefore
 * performs the AUTHORITATIVE final tool-pair-safe trim of the RP history (reserved
 * = framing + snapshots + summaries + private view + private history) when a
 * budget is supplied, so the emitted prompt never silently exceeds the budget.
 */
import type { AssemblePromptResponse, PromptLayerDto } from "@vibe-tavern/domain";
import { estimateTokens, planHistoryCompaction } from "./compaction.js";
import {
	characterSnapshotText,
	personaSnapshotText,
	type ExperienceBudget,
	type ExperienceContextBundle,
	type ExperienceContextCharacter,
	type ExperienceContextMessage,
	type ExperienceContextPersona,
} from "./experience-context.js";

// ─── Experience-owned layer ids (prefixed `xp_` to avoid collision with the
//     chat pipeline's ids; these only ever appear in an experience model
//     prompt, which is a separate prompt shape from `assemblePrompt`). ──────

const XP_LAYER_ID = {
	hostProtocol: "xp_host_protocol",
	packagePrompt: "xp_package_prompt",
	globalOverride: "xp_global_override",
	characterOverride: "xp_character_override",
	character: "xp_character",
	persona: "xp_persona",
	contextSummary: "xp_context_summary",
	contextHistory: "xp_context_history",
	privateHistory: "xp_private_history",
	privateView: "xp_private_view",
} as const;

// Stable priorities within the experience prompt. The order is fixed by
// construction (no resolver/canvas), so priorities exist only for trace-UI
// sorting and to mirror the chat pipeline's "higher = earlier" convention.
const XP_PRIORITY = {
	hostProtocol: 1000,
	packagePrompt: 980,
	globalOverride: 960,
	characterOverride: 940,
	character: 900,
	persona: 850,
	contextSummary: 500,
	contextHistory: 100,
	privateHistory: 90,
	privateView: 80,
} as const;

// ─── Input ───────────────────────────────────────────────────────────────────

export interface ExperienceModelPromptInput {
	/** Host protocol — the host's system framing telling the model what it is
	 *  doing (e.g. "choose a legal action for this participant"). Required. */
	hostProtocol: string;
	/** Package-authored prompt (the script/visual package's own instructions). */
	packagePrompt?: string | null;
	/** User's global experience prompt override (`experience_prompt_overrides`). */
	globalOverride?: string | null;
	/** Character-specific experience prompt override. */
	characterOverride?: string | null;
	/** Frozen RP context bundle (constructed by `buildExperienceContext`). */
	context: ExperienceContextBundle;
	/** Per-seat private view — the ONLY hidden material this model sees (its own
	 *  legal actions / private state). Emitted as the final user message. */
	privateView?: string | null;
	/** Per-seat private history — this participant's own prior moves. */
	privateHistory?: ReadonlyArray<ExperienceContextMessage> | null;
	/** Budget for the FINAL trim. When omitted, the bundle is assembled verbatim
	 *  (the caller opts out of the authoritative final trim). */
	budget?: ExperienceBudget | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FramingBlock {
	id: string;
	sourceName: string;
	text: string;
}

/** Render the non-empty framing blocks (protocol → overrides → snapshots) in
 *  fixed order. Shared by the token-reservation calc and the layer emission so
 *  the accounting and the emitted text can never diverge. */
function renderFramingBlocks(
	input: ExperienceModelPromptInput,
	character: ExperienceContextCharacter | null,
	persona: ExperienceContextPersona | null,
): FramingBlock[] {
	const blocks: FramingBlock[] = [];
	if (input.hostProtocol) {
		blocks.push({ id: XP_LAYER_ID.hostProtocol, sourceName: "Host protocol", text: input.hostProtocol });
	}
	if (input.packagePrompt) {
		blocks.push({ id: XP_LAYER_ID.packagePrompt, sourceName: "Package prompt", text: input.packagePrompt });
	}
	if (input.globalOverride) {
		blocks.push({ id: XP_LAYER_ID.globalOverride, sourceName: "Global override", text: input.globalOverride });
	}
	if (input.characterOverride) {
		blocks.push({ id: XP_LAYER_ID.characterOverride, sourceName: "Character override", text: input.characterOverride });
	}
	if (character) {
		blocks.push({ id: XP_LAYER_ID.character, sourceName: "Character", text: characterSnapshotText(character) });
	}
	if (persona) {
		blocks.push({ id: XP_LAYER_ID.persona, sourceName: "Persona", text: personaSnapshotText(persona) });
	}
	return blocks;
}

function formatHistoryText(messages: ReadonlyArray<ExperienceContextMessage>): string {
	return messages
		.map((m) => `${m.role.toUpperCase()}: ${m.content}`)
		.join("\n\n");
}

function makeLayer(
	id: string,
	sourceName: string,
	text: string,
	priority: number,
): PromptLayerDto {
	return {
		id,
		sourceType: "experience",
		sourceId: id,
		sourceName,
		position: "in_prompt",
		priority,
		enabled: true,
		reason: "experience model-effect prompt (fixed order)",
		tokenCount: estimateTokens(text),
		text,
	};
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildExperienceModelPrompt(
	input: ExperienceModelPromptInput,
): AssemblePromptResponse {
	const character = input.context.character;
	const persona = input.context.persona;
	const framingBlocks = renderFramingBlocks(input, character, persona);

	const privateHistory = input.privateHistory ? [...input.privateHistory] : [];
	const privateView = input.privateView ?? "";

	// Reserved = every non-history token: framing + summaries + private view + private history.
	const framingTokens = framingBlocks.reduce((n, b) => n + estimateTokens(b.text), 0);
	const summaryTokens = input.context.summaries.reduce((n, s) => n + estimateTokens(s.content), 0);
	const privateViewTokens = privateView ? estimateTokens(privateView) : 0;
	const privateHistoryTokens = privateHistory.reduce((n, m) => n + estimateTokens(m.content), 0);
	const reservedTokens = framingTokens + summaryTokens + privateViewTokens + privateHistoryTokens;

	const countHistoryTokens = (msgs: ReadonlyArray<ExperienceContextMessage>): number =>
		msgs.reduce((n, m) => n + estimateTokens(m.content), 0);

	// Authoritative final trim of the RP history (tool-pair-safe, ≥2 preserved).
	const budget = input.budget;
	const plan =
		budget && budget.contextBudget > 0
			? planHistoryCompaction({
					messages: input.context.messages,
					nonHistoryTokens: reservedTokens,
					contextBudget: budget.contextBudget,
					responseReserve: budget.responseReserve,
					countHistoryTokens,
					minPreservedMessages: 2,
				})
			: null;
	const history: ExperienceContextMessage[] = plan ? plan.messages : [...input.context.messages];
	const historyTokens = countHistoryTokens(history);

	const droppedHistoryIds = new Set(plan ? input.context.messages.map((m) => m.id).filter((id) => !history.some((h) => h.id === id)) : []);
	const compactionSummary =
		plan && droppedHistoryIds.size > 0
			? `Experience model prompt budget ${budget!.contextBudget} exceeded once framing/private view were added; dropped ${droppedHistoryIds.size} additional oldest RP message(s) (tool-pair-safe, ≥2 preserved).`
			: input.context.compactionSummary;

	// ── Layers (granular, for the trace UI) ──────────────────────────────────
	const layers: PromptLayerDto[] = framingBlocks.map((b) => {
		const priority =
			b.id === XP_LAYER_ID.hostProtocol ? XP_PRIORITY.hostProtocol
			: b.id === XP_LAYER_ID.packagePrompt ? XP_PRIORITY.packagePrompt
			: b.id === XP_LAYER_ID.globalOverride ? XP_PRIORITY.globalOverride
			: b.id === XP_LAYER_ID.characterOverride ? XP_PRIORITY.characterOverride
			: b.id === XP_LAYER_ID.character ? XP_PRIORITY.character
			: XP_PRIORITY.persona;
		return makeLayer(b.id, b.sourceName, b.text, priority);
	});

	if (input.context.summaries.length > 0) {
		const summaryText = input.context.summaries.map((s) => s.content).join("\n\n");
		layers.push(makeLayer(XP_LAYER_ID.contextSummary, "Included summaries", summaryText, XP_PRIORITY.contextSummary));
	}
	layers.push(makeLayer(XP_LAYER_ID.contextHistory, "RP history", formatHistoryText(history), XP_PRIORITY.contextHistory));
	if (privateHistory.length > 0) {
		layers.push(makeLayer(XP_LAYER_ID.privateHistory, "Private history", formatHistoryText(privateHistory), XP_PRIORITY.privateHistory));
	}
	if (privateView) {
		layers.push(makeLayer(XP_LAYER_ID.privateView, "Private view", privateView, XP_PRIORITY.privateView));
	}

	// ── tokenAccounting (per-layer-id; mirrors layers) ───────────────────────
	const tokenAccounting: Record<string, number> = {};
	for (const layer of layers) tokenAccounting[layer.id] = layer.tokenCount;

	// ── finalPayload.messages (what the executor sends) ──────────────────────
	// Framing blocks → individual system messages (mirrors the chat pipeline's
	// per-in_prompt-layer system messages; the executor merges later if needed).
	const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [];
	for (const b of framingBlocks) {
		messages.push({ role: "system", content: b.text });
	}
	if (input.context.summaries.length > 0) {
		messages.push({
			role: "system",
			content: input.context.summaries.map((s) => s.content).join("\n\n"),
		});
	}
	for (const m of history) {
		messages.push({ role: m.role, content: m.content });
	}
	for (const m of privateHistory) {
		messages.push({ role: m.role, content: m.content });
	}
	if (privateView) {
		// The private view is the question the model answers → final user message.
		messages.push({ role: "user", content: privateView });
	}

	return {
		layers,
		tokenAccounting,
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: { messages },
		prefill: null,
		compactionSummary,
	};
}
