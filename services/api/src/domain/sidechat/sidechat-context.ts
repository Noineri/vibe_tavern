import {
	brandId,
	type ChatBranchId,
	type ChatId,
	type ExperienceCopilotThreadId,
	type PromptPresetId,
	isRecord,
	normalizeSceneTrackerConfig,
	SCENE_PROMPT_FORMAT,
} from "@vibe-tavern/domain";
import type {
	AgentThreadContextEvent,
	CharacterStore,
	ChatStore,
	ChatSummaryStore,
	CopilotContextLink,
	ExperienceCopilotStore,
	MessageStore,
	PresetStore,
	PromptTrace,
	PromptTraceStore,
} from "@vibe-tavern/db";
import {
	buildAssemblyVariableContext,
	createFullMacroEngine,
	createLoreLayerId,
	formatSceneHistory,
	PROMPT_FORMAT,
	type SceneInjectionFormat,
} from "@vibe-tavern/prompt-pipeline";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import {
	resolveObjectiveLongTermContext,
	resolveObjectiveTaskContext,
	type PromptAssemblyService,
} from "../prompt/prompt-assembly-service.js";
import {
	RpSyncThreadNotChatOwnedError,
	type RpSyncPayload,
	type RpVariantSelection,
	type SelectionChangedPayload,
} from "./rp-sync.js";
import { coverRpSyncPayload, createRpSummaryCoverage } from "./rp-summary-coverage.js";
import {
	renderRpPromptView,
	type RpPromptViewLayer,
	type RpPromptViewMessage,
} from "./rp-prompt-view.js";
import {
	renderCharacterSection,
	renderCurrentSceneSection,
	renderLoreSection,
	renderObjectivesSection,
	renderPersonaSection,
	renderTimelineEvent,
	type BranchForkedPayload,
	type LoreEntryInput,
	type SidechatTimelineEvent,
	type VariantsAttachedPayload,
} from "./sidechat-xml.js";

/**
 * The sidechat context loader (SIDECHAT_PLAN SC-3b, reshaped by SC-4d): loads
 * everything a chat-owned sidechat thread's prompt needs and renders it with
 * the SC-3a renderers into TWO parts — the STATIC package (sections in the
 * settled tag-grammar order: character, persona, active_lore, objectives,
 * current_scene; null sections dropped, joined with a blank line) and the
 * frozen timeline EVENTS as flow-ready user-message bodies (SC-4d variant A:
 * the OOC conversation and the events both ride the turn's message flow, so
 * the system message carries no timeline and the model reads ONE
 * chronological flow). The stream (SC-4b) splices the static package into the
 * system message and interleaves the event bodies into the flow by the
 * placement this loader derives.
 *
 * WHY EACH SOURCE IS WHAT IT IS (found 2026-10-19 — three naive sources do
 * NOT give what the RP model saw):
 * - Character: the STORED card carries raw macros, so the canonical
 *   profile.md (`CharacterStore.getProfileMdText`) is macro-resolved here with
 *   the SAME variable context the RP send builds — `buildPipelineContext`
 *   (SC-2a's inputs: dryRun, whole-branch limit) feeds
 *   `buildAssemblyVariableContext`, and the card resolves against that
 *   base context exactly like `applyMacrosToContext`'s first pass resolves
 *   the character fields (assemble.ts). No second macro pipeline is invented.
 * - Persona: the chat's active persona off the same built context (name,
 *   pronouns as-is, description macro-resolved the same way — the RP send
 *   resolves only the description, never the pronouns).
 * - Active lore: the branch's LATEST prompt trace (`getTracesByChat`, newest
 *   first) — the entry list from `activatedLoreEntries` in activation order,
 *   each entry's text from the trace's `assembledLayers` layer `lore_<id>`
 *   (build-lore-layers.ts) — the text the RP model actually received, not the
 *   lore store's current (possibly edited) row. An activated id whose layer
 *   is absent (dropped for empty content at assembly) is skipped: the RP
 *   model never saw it. No trace yet → the section is omitted.
 * - Objectives: the chat row's `insightsObjectiveState`. The `mode`
 *   attribute comes from the state itself (`route` | `goals`,
 *   ObjectiveState.mode); the text reuses the RP path's own derivation —
 *   `resolveObjectiveTaskContext` + `resolveObjectiveLongTermContext`
 *   (prompt-assembly-service.ts, same objectiveEnabled gate and same
 *   active-selection rule as the RP prompt) rendered through `PROMPT_FORMAT`
 *   (long-term line above the active task, the pipeline's settled order).
 *   No new model-facing wording is invented here.
 * - Current scene: the THREAD's branch scene record via
 *   `MessageStore.getCurrentSceneTarget(branchId)` — never the chat-level
 *   cache (that mirrors only the ACTIVE branch) and never
 *   `chat.activeBranchId`. The text is the record serialized by the same
 *   `formatSceneHistory` seam the RP prompt uses, under the record's own
 *   `promptFormat` snapshot (live-config fallback only for legacy records
 *   that predate the snapshot, per the record contract). The RP layer's
 *   `[Scene state]` prefix and injectPrompt lead are NOT carried over — they
 *   are the RP layer's framing, and `<current_scene>` is this package's.
 * - Timeline: SC-1's `listTimeline(threadId)` — the merged order (messages
 *   and events interleaved by seq) is the SINGLE ordering source: the loader
 *   walks it once, counts the message rows, and records per event how many
 *   messages precede it (`precedingMessages`) — the flow builder interleaves
 *   by those counts and never re-derives seq math. The events render with
 *   SC-3a's per-event renderer (same tags, same escaping as before SC-4d);
 *   the MESSAGE rows never render anywhere — the real history rows the
 *   generic loop loads ARE the conversation. Frozen event payloads (plain
 *   JSON) are structurally validated and mapped onto SC-3a's input types; a
 *   payload that does not match its kind's frozen shape THROWS (the
 *   renderer's exhaustiveness guard covers unknown kinds — corrupt payloads
 *   of known kinds surface here instead, never silently pre-filtered).
 * - RP summaries (SC-6): the branch's summaries are read LIVE on every turn
 *   (`ChatSummaryStore.listByChatBranch` — the same read the loaders' `getChatSummaries`
 *   seam makes) and coverage is decided through the RP's own one source
 *   (`buildChatSummaryContext`, via rp-summary-coverage.ts): an enabled
 *   summary renders ONCE as `<rp_summary>` at its first covered position,
 *   its covered frozen messages drop when `excludeSummarized` is on and stay
 *   raw after the row otherwise, and a disabled/empty summary is ignored.
 *   Coverage splits an `rp_sync` batch per message. NOTHING is stored — no
 *   `rp_summary` event is ever written — so editing, disabling or deleting a
 *   summary in the RP chat changes what the sidechat sees on its next turn,
 *   in place.
 * - Pinned prompt presets (SC-23c): while the thread carries a
 *   `prompt_preset` context link, EVERY turn re-assembles the thread's chat +
 *   branch DRY with that preset (`assembleForChat({ presetId, dryRun: true })`
 *   — the per-request override, never the chat's own preset; dryRun advances
 *   no lore timer and no script state) and renders the payload through the
 *   shared RP prompt view (`rp-prompt-view.ts`) against the sidechat's held
 *   set — the branch's active lore ids — into a trailing `<rp_prompt>` static
 *   section. The discussion is «edit the block, ask again»: an edited preset
 *   block shows on the NEXT turn because nothing is cached. A deleted preset
 *   is a dangling link, skipped like every other dangling target — never a
 *   400 on the turn. Without a pin NOTHING changes (owner decision 1 holds
 *   by default; the pin is the whole point of the arm).
 *
 * Must stay true: NO store writes anywhere (the lore activation inside
 * buildPipelineContext runs dryRun, like every sidechat read); the RP prompt
 * path is untouched. A thread that is not chat-owned (script-owned, draft,
 * missing) is refused with SC-2c's typed error before any RP-chat read — the
 * same refusal the RP sync uses, one class, not a copy.
 */

/** The stores/services this loader reads — `Pick`s so tests and callers can
 *  pass narrow seams instead of whole containers. */
export interface SidechatContextDeps {
	/** The chat row — objectives state + insights config. */
	chats: Pick<ChatStore, "getById">;
	/** The canonical character card (profile.md text, raw macros). */
	characters: Pick<CharacterStore, "getProfileMdText">;
	/** Branch length (the SC-2a whole-branch read limit) + the thread branch's
	 *  scene target; `getVariantsByBranch` also feeds the SC-23e reply-prompt
	 *  read tool's variant resolution (the same store seam, one wiring). */
	messages: Pick<MessageStore, "getMessages" | "getCurrentSceneTarget" | "getVariantsByBranch">;
	/** The branch's prompt traces (latest first); `getTraceByVariant` resolves
	 *  the trace SC-23b linked to one swipe (the reply-prompt read, SC-23e). */
	traces: Pick<PromptTraceStore, "getTracesByChat" | "getTraceByVariant">;
	/** The branch's RP summaries — read LIVE every turn (SC-6). */
	chatSummaries: Pick<ChatSummaryStore, "listByChatBranch">;
	/** The thread row + the merged frozen timeline. */
	experienceCopilot: Pick<ExperienceCopilotStore, "getById" | "listTimeline">;
	/** SC-23c: pinned-preset existence — a dangling id skips the pin, exactly
	 *  like every other dangling context-link target. */
	presets: Pick<PresetStore, "getById">;
	/** The RP assembly service — supplies the send path's own inputs. */
	assembly: PromptAssemblyService;
}

// ─── The loaded package (SC-3b static sections + SC-4d flow-placed events) ───

/** One frozen RP event placed for the turn's message flow (SC-4d): the
 *  event's rendered user-message body (SC-3a's per-event renderer — same
 *  tags, same escaping) plus how many of the thread's MESSAGE rows precede
 *  it on the merged timeline. The count IS the placement: listTimeline's
 *  merged order is the single ordering source, so the flow builder
 *  interleaves by these counts instead of re-deriving seq arithmetic.
 *  Since SC-9 each row also carries the METER SEGMENT its tokens feed
 *  (`rp_summaries` for `<rp_summary>` rows, `rp_messages` for every other
 *  RP event) — the classification is decided HERE, where the row's kind is
 *  known, and consumed downstream; no second derivation of which row is
 *  what. */
export interface SidechatEventMessage {
	readonly precedingMessages: number;
	readonly content: string;
	readonly meterSegment: SidechatEventMeterSegment;
}

/** The sidechat kind's five meter segment keys (SC-9; the SC-0j wire
 *  vocabulary — labels land in SC-13's host descriptor, the web side keys
 *  off these same strings). Declared in THIS module (not the stream's,
 *  which imports it) because the loader classifies event rows into the two
 *  RP-layer keys and the stream builds the five-key array — one
 *  declaration, both consumers, no import cycle.
 *  `context` = everything constant in the system message — base prompt,
 *  card, persona, active lore, objectives, scene, the skill catalog and the
 *  `@` links (the pinned block rides `attached` tokens) — one bucket
 *  because a narrower name (e.g. `cards_lore`) would hide the rest under a
 *  wrong label (owner decision 3, SIDECHAT_PLAN SC-9, 2026-10-20). */
export const SIDECHAT_OOC_METER_SEGMENT_KEYS = [
	"context",
	"rp_summaries",
	"rp_messages",
	"digest",
	"discussion",
] as const;
export type SidechatOocMeterSegmentKey = (typeof SIDECHAT_OOC_METER_SEGMENT_KEYS)[number];

/** The two RP-layer meter segments a timeline event row can feed (SC-9):
 *  summary rows vs every other frozen RP event (rp_sync message blocks,
 *  variants, selection changes, forks — all story material, none of it a
 *  summary). */
export type SidechatEventMeterSegment = Extract<
	SidechatOocMeterSegmentKey,
	"rp_summaries" | "rp_messages"
>;

/** The one classification derivation (SC-9): `<rp_summary>` rows feed the
 *  summaries segment, every other event row feeds the messages segment. */
function meterSegmentOfEvent(kind: string): SidechatEventMeterSegment {
	return kind === "rp_summary" ? "rp_summaries" : "rp_messages";
}

/** The sidechat turn's loaded context (SC-3b, reshaped by SC-4d): the STATIC
 *  package string (the five settled sections — NO timeline; since SC-4d the
 *  OOC conversation and the frozen events both ride the message flow) plus
 *  the frozen events rendered into flow-ready user-message bodies. */
export interface SidechatContextPackage {
	/** The static sections joined with a blank line (SC-3a grammar order). */
	readonly staticPackage: string;
	/** The frozen events, in merged-timeline order (SC-4d placement counts). */
	readonly eventMessages: readonly SidechatEventMessage[];
	/** The merged timeline's MESSAGE row count — the flow builder's alignment
	 *  guard against a history that no longer matches the timeline (e.g. a
	 *  compaction digest split, which Wave 2 does not wire here yet). */
	readonly messageCount: number;
	/** SC-23e: the sidechat's held lore entry ids — the ids its `active_lore`
	 *  section shows (the one derivation, from the same rows the section
	 *  rendered). The RP prompt view collapses exactly these lore layers to
	 *  placeholders; the reply-prompt read tool renders its trace view against
	 *  THIS set, so the marker and the granted prompt agree with what the
	 *  sidechat already holds this turn. */
	readonly heldLoreEntryIds: ReadonlySet<string>;
}

/**
 * Load the sidechat context for a chat-owned thread: the static package +
 * the flow-placed frozen events. Throws {@link RpSyncThreadNotChatOwnedError}
 * for a script-owned, draft, or missing thread (same typed refusal as the RP
 * sync — one class).
 */
export async function loadSidechatContext(
	deps: SidechatContextDeps,
	threadId: ExperienceCopilotThreadId,
): Promise<SidechatContextPackage> {
	const thread = await deps.experienceCopilot.getById(threadId);
	// Same narrowing as syncBeforeUserMessage (SC-2c): a null branchId on a
	// chat-owned row is corruption — refused, never read through.
	if (thread === null || !isChatOwnedAgentThread(thread) || thread.branchId === null) {
		throw new RpSyncThreadNotChatOwnedError(threadId);
	}
	// brandId at the consuming edge of the store projection — the owner
	// columns are plain strings on the row (ER-3), same seam as SC-2c.
	const chatId = brandId<ChatId>(thread.chatId);
	const branchId = brandId<ChatBranchId>(thread.branchId);

	const chat = await deps.chats.getById(thread.chatId);
	if (chat === null) {
		// The FK cascade deletes the thread with its chat, so this is
		// unreachable outside a concurrent chat delete mid-load — mirror
		// SC-2c's branch-miss refusal rather than read through a dangling row.
		throw new Error(
			`loadSidechatContext: thread "${threadId}" owns chat ${thread.chatId}, but the chat does not resolve (deleted mid-load?)`,
		);
	}

	// SC-2a's inputs exactly: the whole branch is the read window (no
	// messageHistoryLimit window), lore activation dry, the no-model sentinel.
	const branchMessages = await deps.messages.getMessages(branchId);
	const built = await deps.assembly.buildPipelineContext({
		chatId,
		branchId,
		model: "",
		dryRun: true,
		recentMessageLimit: branchMessages.length,
	});

	// The RP send's own macro seam: the full engine over the assembly-scoped
	// variable scope, resolving against the base (raw-field) context — the
	// same first pass applyMacrosToContext applies to the character/persona
	// fields (assemble.ts).
	const macroEngine = createFullMacroEngine(built.context.macroVariableScope);
	const baseVariableContext = buildAssemblyVariableContext(built.context);

	const characterSection = renderCharacterSection({
		name: built.context.character.name,
		card: macroEngine.resolve(await deps.characters.getProfileMdText(built.context.character.id), baseVariableContext),
	});

	const persona = built.context.persona;
	const personaSection = persona === null || persona === undefined
		? null
		: renderPersonaSection({
			name: persona.name,
			pronouns: persona.pronouns ?? null,
			text: macroEngine.resolve(persona.description, baseVariableContext),
		});

	const loreRows = await loadLoreEntries(deps, chatId, branchId);
	const loreSection = renderLoreSection(loreRows);
	// SC-23c: the sidechat's held lore set — the ids its active_lore section
	// shows. The RP prompt view collapses exactly these lore layers to
	// placeholders; a lore entry OUTSIDE this set renders in full there (the
	// difference is the point).
	const heldLoreEntryIds = new Set(loreRows.map((row) => row.id));

	const objectivesSection = renderObjectivesSection(loadObjectivesInput(chat));

	const sceneSection = renderCurrentSceneSection(await loadCurrentSceneText(deps, chat, branchId));

	// SC-23c: the pinned-preset RP prompt views — one trailing section per
	// pinned link, re-assembled dry on EVERY load (see the module doc).
	const presetViews = await loadPinnedPresetViews(
		deps,
		thread.contextLinks,
		chatId,
		branchId,
		branchMessages,
		heldLoreEntryIds,
	);

	// Static package (SC-4d): the five settled sections (+ any pinned-preset
	// RP prompt views, SC-23c) only — no timeline section exists anymore; the
	// timeline walk below feeds the MESSAGE FLOW.
	const sections = [characterSection, personaSection, loreSection, objectivesSection, sceneSection, ...presetViews];
	const staticPackage = sections.filter((section): section is string => section !== null).join("\n\n");

	// Timeline walk (SC-4d): consume listTimeline's merged order ONCE — the
	// single ordering source. Message rows are COUNTED (they ride the flow as
	// the real history rows the generic loop already loaded); each event row
	// becomes a rendered user-message body tagged with how many messages
	// precede it, so the flow builder interleaves without seq arithmetic.
	// `rp_sync` events go through SC-6's coverage first (the summaries are
	// read live above the walk): covered messages drop per message inside the
	// batch and an enabled summary renders once at its first covered
	// position — one stored event can become several rendered rows.
	const timeline = await deps.experienceCopilot.listTimeline(threadId);
	const coverage = createRpSummaryCoverage(
		await deps.chatSummaries.listByChatBranch(chatId, branchId),
	);
	let messageCount = 0;
	const eventMessages: SidechatEventMessage[] = [];
	for (const entry of timeline) {
		if (entry.rowType === "message") {
			messageCount += 1;
			continue;
		}
		const mapped = mapTimelineEvent(threadId, entry);
		if (mapped.kind === "rp_sync") {
			for (const row of coverRpSyncPayload(mapped.payload, coverage)) {
				eventMessages.push({
					precedingMessages: messageCount,
					content: renderTimelineEvent(row),
					meterSegment: meterSegmentOfEvent(row.kind),
				});
			}
			continue;
		}
		eventMessages.push({
			precedingMessages: messageCount,
			content: renderTimelineEvent(mapped),
			meterSegment: meterSegmentOfEvent(mapped.kind),
		});
	}
	// Enabled summaries whose range never anchored during the walk (beyond
	// the frozen frontier, or their messages deleted) still render — at the
	// end of the event flow, never silently dropped.
	for (const row of coverage.tailRows()) {
		eventMessages.push({
			precedingMessages: messageCount,
			content: renderTimelineEvent(row),
			meterSegment: meterSegmentOfEvent(row.kind),
		});
	}

	return { staticPackage, eventMessages, messageCount, heldLoreEntryIds };
}

// ─── Active lore (the branch's latest prompt trace) ──────────────────────────

/** One active lore row with its entry id (what the SC-23c held set and the
 *  RP prompt view's lore check read) beside the renderer's title/text pair. */
type ActiveLoreRow = LoreEntryInput & { readonly id: string };

/** Map a trace onto the renderer's lore entries: `activatedLoreEntries` in
 *  activation order, text + title from the trace's own `lore_<id>` layers. */
async function loadLoreEntries(
	deps: SidechatContextDeps,
	chatId: ChatId,
	branchId: ChatBranchId,
): Promise<ActiveLoreRow[]> {
	// getTracesByChat returns newest first (desc createdAt, desc id) — the
	// first row IS the branch's latest trace. No trace yet → no section.
	const traces = await deps.traces.getTracesByChat(chatId, branchId);
	const trace: PromptTrace | undefined = traces[0];
	if (trace === undefined) return [];

	// Index the trace's layers by id once; assembledLayers is plain JSON
	// (layer DTOs), so shape-check every row before trusting it.
	const layersById = new Map<string, Record<string, unknown>>();
	for (const layer of trace.assembledLayers) {
		if (isRecord(layer) && typeof layer.id === "string") layersById.set(layer.id, layer);
	}

	const entries: ActiveLoreRow[] = [];
	for (const entryId of trace.activatedLoreEntries) {
		const layer = layersById.get(createLoreLayerId(entryId));
		// An activated id with no layer was DROPPED at assembly (e.g. empty
		// content — buildLoreLayers) — the RP model never saw it, so the
		// sidechat does not see it either.
		if (layer === undefined) continue;
		const text = layer.text;
		const title = layer.sourceName;
		if (typeof text !== "string" || typeof title !== "string") {
			throw new Error(
				`loadSidechatContext: trace ${trace.id} layer ${createLoreLayerId(entryId)} is not the frozen layer shape — refusing to render corrupted frozen context`,
			);
		}
		entries.push({ id: entryId, title, text });
	}
	return entries;
}

// ─── Pinned prompt presets (SC-23c — the RP prompt view arm) ────────────────

/** The branch message row subset the preset arm reads (the whole-branch read
 *  limit + the position map for the view's history placeholders). */
type BranchMessageRow = { id: string; position: number };

/** Render one `<rp_prompt>` view per pinned `prompt_preset` link, in link
 *  order: a dangling preset id (deleted) skips the pin — never a 400 on the
 *  turn, the same skip every other dangling context-link target gets. Each
 *  view comes from a DRY whole-branch assembly with THAT preset — the
 *  per-request override (never the chat's own preset, never a chat write),
 *  re-run on every call so an edited block shows on the next turn. */
async function loadPinnedPresetViews(
	deps: SidechatContextDeps,
	links: readonly CopilotContextLink[],
	chatId: ChatId,
	branchId: ChatBranchId,
	branchMessages: readonly BranchMessageRow[],
	heldLoreEntryIds: ReadonlySet<string>,
): Promise<string[]> {
	const presetLinks = links.filter((link) => link.targetType === "prompt_preset");
	if (presetLinks.length === 0) return [];
	const positionByMessageId = new Map(branchMessages.map((message) => [message.id, message.position]));
	const views: string[] = [];
	for (const link of presetLinks) {
		const preset = await deps.presets.getById(link.targetId);
		if (preset === null) continue;
		const assembled = await deps.assembly.assembleForChat({
			chatId,
			branchId,
			model: "",
			dryRun: true,
			// The SC-2a whole-branch window — the same limit the loader's own
			// buildPipelineContext call passes, so the view's history
			// placeholders carry the branch's real positions.
			recentMessageLimit: branchMessages.length,
			presetId: brandId<PromptPresetId>(link.targetId),
		});
		const view = renderRpPromptView({
			presetName: preset.name,
			messages: mapFinalPayloadMessages(assembled.prompt.finalPayload, positionByMessageId, `preset ${link.targetId} assembly`),
			layers: assembled.prompt.layers,
			heldLoreEntryIds,
		});
		if (view !== null) views.push(view);
	}
	return views;
}

/** Map a frozen final payload (plain JSON — a dry assembly's response or a
 *  stored trace's `finalPayload`, the same shape both freeze) onto the view's
 *  message input, enriching every history ref with its branch position from
 *  the caller's own branch read. Exported since SC-23e: the reply-prompt read
 *  tool maps a STORED TRACE's payload through this same mapper — one mapping,
 *  both arms of the RP prompt view. `origin` names the source in every
 *  refusal message ("preset <id> assembly" / "trace <id>"). Structural checks
 *  throw the corrupt refusal the module's other mappers use — the payload
 *  comes from our own assembly or our own trace store, so a mismatch is a
 *  programming error, never user data. */
export function mapFinalPayloadMessages(
	payload: Record<string, unknown>,
	positionByMessageId: ReadonlyMap<string, number>,
	origin: string,
): RpPromptViewMessage[] {
	const raw = payload.messages;
	if (!Array.isArray(raw)) {
		throw new Error(
			`loadSidechatContext: ${origin} returned a final payload without a messages array — refusing to render a corrupted payload`,
		);
	}
	const positionOf = (messageId: string): number | undefined => positionByMessageId.get(messageId);
	return raw.map((entry): RpPromptViewMessage => {
		if (!isRecord(entry) || typeof entry.role !== "string" || typeof entry.content !== "string") {
			throw new Error(
				`loadSidechatContext: ${origin} returned a payload entry that is not { role, content } — refusing to render a corrupted payload`,
			);
		}
		const role = entry.role;
		if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
			throw new Error(
				`loadSidechatContext: ${origin} returned an unknown payload role "${role}" — refusing to render a corrupted payload`,
			);
		}
		const messageId = typeof entry.messageId === "string" ? entry.messageId : undefined;
		const layerId = typeof entry.layerId === "string" ? entry.layerId : undefined;
		const position = messageId !== undefined ? positionOf(messageId) : undefined;
		const mergedFrom = Array.isArray(entry.mergedFrom)
			? entry.mergedFrom.map((ref: unknown) => {
					if (!isRecord(ref)) {
						throw new Error(
							`loadSidechatContext: ${origin} returned a mergedFrom ref that is not a record — refusing to render a corrupted payload`,
						);
					}
					const refMessageId = typeof ref.messageId === "string" ? ref.messageId : undefined;
					const refPosition = refMessageId !== undefined ? positionOf(refMessageId) : undefined;
					return {
						...(refMessageId !== undefined ? { messageId: refMessageId } : {}),
						...(typeof ref.layerId === "string" ? { layerId: ref.layerId } : {}),
						...(refPosition !== undefined ? { position: refPosition } : {}),
					};
				})
			: undefined;
		return {
			role,
			content: entry.content,
			...(messageId !== undefined ? { messageId } : {}),
			...(layerId !== undefined ? { layerId } : {}),
			...(position !== undefined ? { position } : {}),
			...(mergedFrom !== undefined ? { mergedFrom } : {}),
		};
	});
}

// ─── Objectives (the chat row's state, via the RP path's own derivation) ─────

type ChatRow = NonNullable<Awaited<ReturnType<ChatStore["getById"]>>>;

/** The objectives section input: `mode` straight off the state, the text from
 *  the RP prompt's own objective derivations and wording. */
function loadObjectivesInput(chat: ChatRow): { mode: "route" | "goals"; text: string } {
	const insightsObjectiveState = chat.insightsObjectiveState;
	const task = resolveObjectiveTaskContext({
		insightsConfig: chat.insightsConfig,
		insightsObjectiveState,
	});
	const longTerm = resolveObjectiveLongTermContext({
		insightsConfig: chat.insightsConfig,
		insightsObjectiveState,
	});
	// Long-term goal above the active task — the order the RP prompt settles
	// (PROMPT_FORMAT.objectiveLongTerm's contract; the pipeline renders both
	// goals-mode layers together at the decision point).
	const text = [
		longTerm !== null ? PROMPT_FORMAT.objectiveLongTerm(longTerm.injectPrompt, longTerm.description) : null,
		task !== null ? PROMPT_FORMAT.objectiveTask(task.injectPrompt, task.description) : null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return { mode: insightsObjectiveState.mode, text };
}

// ─── Current scene (the THREAD's branch record) ──────────────────────────────

/** Serialize the thread branch's current scene record with the RP prompt's own
 *  formatter, under the record's own prompt-format snapshot (live-config
 *  fallback for pre-snapshot legacy records only). */
async function loadCurrentSceneText(
	deps: SidechatContextDeps,
	chat: ChatRow,
	branchId: ChatBranchId,
): Promise<string> {
	const target = await deps.messages.getCurrentSceneTarget(branchId);
	if (target === null) return "";
	const format: SceneInjectionFormat = target.record.promptFormat
		?? (chat.insightsConfig.tracker
			? normalizeSceneTrackerConfig(chat.insightsConfig.tracker).promptFormat
			: SCENE_PROMPT_FORMAT.json);
	return formatSceneHistory([target.record.sceneState], format);
}

// ─── Timeline (frozen payloads → SC-3a input types) ──────────────────────────

/** Corrupt-payload refusal: a known kind whose stored payload does not match
 *  its frozen shape. Throwing (not skipping) is the contract — silently
 *  dropping an event would change what the model is shown. */
function corrupt(threadId: string, kind: string, seq: number | null, detail: string): never {
	throw new Error(
		`loadSidechatContext: thread ${threadId} event ${kind} (seq ${seq ?? "none"}) payload is not the frozen shape (${detail}) — refusing to render corrupted frozen context`,
	);
}

/** Map one merged-timeline EVENT row (SC-1) onto the renderer's entry type.
 * `where` names the row in every parser's refusal message. The `rp_sync`
 * case only PARSES — the walk routes that kind through SC-6's coverage
 * (its batch is split per message by summary coverage) before rendering.
 * Exported since SC-8c: the sidechat compaction service maps the SAME
 * frozen rows (through the SAME validation + refusal path) when it renders
 * the summarizer transcript's reference events — one derivation. */
export function mapTimelineEvent(threadId: string, entry: AgentThreadContextEvent): SidechatTimelineEvent {
	const where = { threadId, kind: entry.kind, seq: entry.seq };
	switch (entry.kind) {
		case "rp_sync":
			return { rowType: "event", kind: "rp_sync", payload: parseRpSyncPayload(where, entry.payload) };
		case "variants_attached":
			return {
				rowType: "event",
				kind: "variants_attached",
				payload: parseVariantsAttachedPayload(where, entry.payload),
			};
		case "selection_changed":
			return {
				rowType: "event",
				kind: "selection_changed",
				payload: parseSelectionChangedPayload(where, entry.payload),
			};
		case "branch_forked":
			return { rowType: "event", kind: "branch_forked", payload: parseBranchForkedPayload(where, entry.payload) };
	}
	// No default: the store's kind union is closed. A new kind makes this
	// switch non-exhaustive at compile time — teach this mapper before writing
	// that kind.
}

interface EventWhere {
	threadId: string;
	kind: string;
	seq: number | null;
}

function parseRpSyncPayload(where: EventWhere, payload: unknown): RpSyncPayload {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		corrupt(where.threadId, where.kind, where.seq, "messages array missing");
	}
	const messages = payload.messages.map((raw: unknown): RpSyncPayload["messages"][number] => {
		if (!isRecord(raw)) corrupt(where.threadId, where.kind, where.seq, "message row is not a record");
		const id = raw.id;
		const position = raw.position;
		const role = raw.role;
		const authorName = raw.authorName ?? null;
		const variantId = raw.variantId ?? null;
		const model = raw.model ?? null;
		const preset = raw.preset ?? null;
		const text = raw.text;
		if (typeof id !== "string" || typeof position !== "number" || typeof text !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "message id/position/text not strings/number");
		}
		if (
			role !== "system" && role !== "user" && role !== "assistant" && role !== "tool"
		) {
			corrupt(where.threadId, where.kind, where.seq, `unknown message role "${String(role)}"`);
		}
		if (authorName !== null && typeof authorName !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "authorName is neither string nor null");
		}
		if (variantId !== null && typeof variantId !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variantId is neither string nor null");
		}
		if (model !== null && typeof model !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "model is neither string nor null");
		}
		if (preset !== null && typeof preset !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "preset is neither string nor null");
		}
		return { id, position, role, authorName, variantId, model, preset, text };
	});
	const fromPosition = payload.fromPosition;
	const toPosition = payload.toPosition;
	if (typeof fromPosition !== "number" || typeof toPosition !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "fromPosition/toPosition not numbers");
	}
	return { fromPosition, toPosition, messages };
}

function parseVariantsAttachedPayload(where: EventWhere, payload: unknown): VariantsAttachedPayload {
	if (!isRecord(payload) || typeof payload.position !== "number" || !Array.isArray(payload.variants)) {
		corrupt(where.threadId, where.kind, where.seq, "position/variants missing");
	}
	const variants = payload.variants.map((raw: unknown): VariantsAttachedPayload["variants"][number] => {
		if (!isRecord(raw) || typeof raw.text !== "string" || typeof raw.selected !== "boolean") {
			corrupt(where.threadId, where.kind, where.seq, "variant text/selected missing");
		}
		// SC-23a provenance — absent on events frozen before the unit, so
		// each normalizes to null (the attribute renders only when non-null).
		const number = raw.number ?? null;
		const model = raw.model ?? null;
		const preset = raw.preset ?? null;
		if (number !== null && typeof number !== "number") {
			corrupt(where.threadId, where.kind, where.seq, "variant number is neither number nor null");
		}
		if (model !== null && typeof model !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variant model is neither string nor null");
		}
		if (preset !== null && typeof preset !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variant preset is neither string nor null");
		}
		return { text: raw.text, selected: raw.selected, number, model, preset };
	});
	return { position: payload.position, variants };
}

function parseSelectionChangedPayload(where: EventWhere, payload: unknown): SelectionChangedPayload {
	if (!isRecord(payload) || typeof payload.messageId !== "string" || typeof payload.position !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "messageId/position missing");
	}
	return {
		messageId: payload.messageId,
		position: payload.position,
		previous: parseVariantSelection(where, payload.previous),
		current: parseVariantSelection(where, payload.current),
	};
}

function parseVariantSelection(where: EventWhere, raw: unknown): RpVariantSelection {
	if (!isRecord(raw) || typeof raw.variantId !== "string" || typeof raw.text !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current variant pair missing");
	}
	// SC-23a provenance — absent on events frozen before the unit → null.
	const model = raw.model ?? null;
	const preset = raw.preset ?? null;
	if (model !== null && typeof model !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current model is neither string nor null");
	}
	if (preset !== null && typeof preset !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current preset is neither string nor null");
	}
	return { variantId: raw.variantId, text: raw.text, model, preset };
}

function parseBranchForkedPayload(where: EventWhere, payload: unknown): BranchForkedPayload {
	if (!isRecord(payload) || typeof payload.at !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "at missing");
	}
	return { at: payload.at };
}
