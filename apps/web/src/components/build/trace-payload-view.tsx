/**
 * Wave C — payload-faithful trace view.
 *
 * Renders `trace.finalPayload.messages` (the exact array sent to the model)
 * instead of a flat priority-sorted `trace.layers` list. The payload splits
 * into two regions:
 *
 *   1. Preamble — the leading run of `layerId` entries before the first chat
 *      message (system prompt, character, lore, examples, ...). Rendered as
 *      flat collapsible cards.
 *   2. Chat History — from the first `messageId` entry to the end. Contains
 *      the chat messages interleaved with in-chat injects. Rendered inside one
 *      outer "Chat History" accordion (collapsed by default): injects and
 *      message runs are BOTH collapsible accordions — inject headers are
 *      divider-styled (depth + tokens on a rule line) and expand to show the
 *      injected text; message runs collapse to one line and expand to show
 *      each message.
 *
 * Source of truth is `finalPayload.messages` (the interleaved order the model
 * received). `trace.layers` is only consulted to enrich inject dividers with
 * metadata (sourceName, depth, tokens, text) keyed by `layerId`.
 *
 * See PROMPT_TRACE_PAYLOAD_FIX_PLAN.md, Wave C.
 */
import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AssemblePromptResponse, PromptLayerDto, LoreActivationReason } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";

/**
 * Render a structured lore-activation reason as a small color-coded badge.
 * Shown next to the entry title in the trace so the user can see WHY each
 * lore entry fired (constant / sticky / delay / @@activate / key match).
 */
function LoreReasonBadge({ reason }: { reason: LoreActivationReason }) {
  const { t } = useT();
  let label: string;
  let cls: string;
  switch (reason.kind) {
    case "constant":
      label = t("lore_reason_constant");
      cls = "bg-s3 text-t3";
      break;
    case "sticky":
      label = t("lore_reason_sticky", { since: reason.turnsSinceActivation, window: reason.window });
      cls = "bg-warning-dim text-warning-text";
      break;
    case "delay_fulfilled":
      label = t("lore_reason_delay_fulfilled");
      cls = "bg-warning-dim text-warning-text";
      break;
    case "decorator":
      label = t("lore_reason_decorator");
      cls = "bg-accent-dim text-accent-t";
      break;
    case "key_match": {
      const keys = reason.matchedKeys.join(", ");
      label = reason.scanState === "recursion"
        ? t("lore_reason_key_match_recursion", { keys })
        : t("lore_reason_key_match", { keys });
      cls = "bg-success-dim text-success-text";
      break;
    }
  }
  return (
    <span className={cn("shrink-0 rounded px-1 py-0.5 font-ui text-[10px] font-medium", cls)} title={label}>
      {label}
    </span>
  );
}

/** Badge surfacing a merge-squashed payload entry: "+N merged" with the
 *  absorbed ids/names as the tooltip. Keeps the trace payload-faithful —
 *  without it a merged entry renders as a truncated fragment because the
 *  absorbed sources have no payload entries of their own. */
function MergedBadge({ count, names }: { count: number; names?: string[] }) {
	const { t } = useT();
	if (count <= 0) return null;
	return (
		<span
			className="shrink-0 rounded bg-s3 px-1 py-0.5 font-ui text-[10px] font-medium text-t3"
			title={names && names.length > 0 ? names.join(", ") : undefined}
		>
			{t("trace_merged_badge", { n: count })}
		</span>
	);
}

/** One entry of `finalPayload.messages`. Content may be a string or a vision part-array. */
export interface PayloadMessage {
	role?: string;
	content?: unknown;
	layerId?: string;
	messageId?: string;
	/** Present when `mergeConsecutiveRoles` squashed same-role neighbours into
	 *  this entry — lists the absorbed refs (their ids no longer have their own
	 *  payload entries). Payload-faithful rendering surfaces these as badges. */
	mergedFrom?: Array<{ messageId?: string; layerId?: string }>;
}

/** Enriched in-chat inject (a `layerId` entry inside the history region). */
export interface InjectEntry {
	kind: "inject";
	layerId: string;
	sourceName: string;
	sourceType: string;
	depth: number | undefined;
	tokenCount: number;
	text: string;
	/** Absorbed same-role neighbours (see `PayloadMessage.mergedFrom`). */
	mergedFrom: Array<{ messageId?: string; layerId?: string }>;
}

/** A run of consecutive chat messages between two dividers. */
export interface MessageGroupEntry {
	kind: "messages";
	/** 1-based display index of the first message in this group (within history). */
	start: number;
	/** 1-based display index of the last message in this group. */
	end: number;
	count: number;
	messages: Array<{ role: string; content: string; messageId?: string; mergedFrom?: Array<{ messageId?: string; layerId?: string }> }>;
}

/** A preamble payload entry — the layer card plus payload-faithful content.
 *  With `mergeConsecutiveRoles` ON, same-role preamble layers squash into one
 *  payload entry whose `content` is the concatenation; `mergedLayerIds` lists
 *  the absorbed layer ids (empty when the entry wasn't merged). */
export interface PreambleEntry {
	layer: PromptLayerDto;
	/** The payload entry's own content (survivor text + absorbed texts). */
	text: string;
	/** Layer ids absorbed into this entry (empty = not merged). */
	mergedLayerIds: string[];
	/** Display names for the absorbed layers (sourceName, falling back to the raw id). */
	mergedNames: string[];
}

export interface PayloadGrouping {
	/** Preamble entries (leading `layerId` entries before any chat message). */
	preamble: PreambleEntry[];
	/** Ordered injects + message groups that make up the Chat History region. */
	history: Array<InjectEntry | MessageGroupEntry>;
	/** Whether the payload had any chat-message entries at all. */
	hasHistory: boolean;
}

/** Coerce a finalPayload `content` (string | vision part-array) to plain text. */
function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string"
						? (part as { text: string }).text
						: ""),
			)
			.join("");
	}
	return "";
}

/**
 * Split the interleaved payload into preamble layers + an ordered history
 * region (injects + message groups). Pure function — unit-tested separately
 * from rendering.
 */
export function groupPayloadForTrace(
	messages: PayloadMessage[],
	layers: PromptLayerDto[],
): PayloadGrouping {
	const layerMap = new Map(layers.map((l) => [l.id, l]));
	const firstMsgIdx = messages.findIndex((m) => m.messageId);
	const hasHistory = firstMsgIdx !== -1;

	const preambleRaw = hasHistory ? messages.slice(0, firstMsgIdx) : messages;
	const preamble: PreambleEntry[] = preambleRaw.flatMap((m) => {
		if (!m.layerId) return [];
		const layer = layerMap.get(m.layerId);
		if (!layer) return [];
		const mergedLayerIds = (m.mergedFrom ?? []).flatMap((r) => (r.layerId ? [r.layerId] : []));
		return [{
			layer,
			// Payload-faithful: with merge ON the payload content is the
			// concatenation of the survivor + absorbed layers, while layer.text
			// holds only the survivor's own text (the visible-truncation bug).
			text: contentToString(m.content) || layer.text,
			mergedLayerIds,
			mergedNames: mergedLayerIds.map((id) => layerMap.get(id)?.sourceName ?? id),
		}];
	});

	const historyRegion = hasHistory ? messages.slice(firstMsgIdx) : [];
	const history: Array<InjectEntry | MessageGroupEntry> = [];

	let currentRun: Array<{ role: string; content: string; messageId?: string; mergedFrom?: Array<{ messageId?: string; layerId?: string }> }> = [];
	let runStart = 0;
	let msgCounter = 0;

	const flushRun = () => {
		if (currentRun.length === 0) return;
		history.push({
			kind: "messages",
			start: runStart,
			end: runStart + currentRun.length - 1,
			count: currentRun.length,
			messages: currentRun,
		});
		currentRun = [];
	};

	for (const entry of historyRegion) {
		if (entry.layerId) {
			flushRun();
			const layer = layerMap.get(entry.layerId);
			history.push({
				kind: "inject",
				layerId: entry.layerId,
				sourceName: layer?.sourceName ?? entry.layerId,
				sourceType: layer?.sourceType ?? "",
				depth: layer?.injectionDepth,
				tokenCount: layer?.tokenCount ?? 0,
				// Payload-first: when this inject absorbed same-role chat messages,
				// the payload content is the merged text — layer.text would show
				// only the inject's own text and silently hide the absorbed part.
				text: contentToString(entry.content) || layer?.text || "",
				mergedFrom: entry.mergedFrom ?? [],
			});
		} else if (entry.messageId) {
			msgCounter += 1;
			if (currentRun.length === 0) runStart = msgCounter;
			currentRun.push({
				role: entry.role ?? "system",
				content: contentToString(entry.content),
				messageId: entry.messageId,
				...(entry.mergedFrom ? { mergedFrom: entry.mergedFrom } : {}),
			});
		}
	}
	flushRun();

	return { preamble, history, hasHistory };
}

interface TracePayloadViewProps {
	trace: AssemblePromptResponse;
	searchQuery: string;
	formatTokens: (n: number) => string;
	/** Dense single-row cards (desktop). Defaults to the two-row mobile layout. */
	compact?: boolean;
}

export function TracePayloadView({ trace, searchQuery, formatTokens, compact = false }: TracePayloadViewProps) {
	const { t } = useT();
	const [historyOpen, setHistoryOpen] = useState(false);
	const [openLayers, setOpenLayers] = useState<Set<string>>(new Set());
	const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
	const [openInjects, setOpenInjects] = useState<Set<string>>(new Set());

	const q = searchQuery.trim().toLowerCase();
	const matches = (...vals: Array<unknown>) =>
		!q || vals.filter(Boolean).some((v) => String(v).toLowerCase().includes(q));

	// Map lore-entry ids and layer ids → activation reason (parallel to
	// `activatedLoreEntries`). Built from `activatedLoreDetail` (entry id keyed)
	// plus a layer-id index so inject entries (which carry layerId, not entryId)
	// can also resolve their reason.
	const loreReasonByEntryId = new Map((trace.activatedLoreDetail ?? []).map((d) => [d.id, d.reason]));
	const loreReasonByLayerId = new Map(
		trace.layers
			.filter((l) => l.sourceType === "lore_entry" && loreReasonByEntryId.has(l.sourceId))
			.map((l) => [l.id, loreReasonByEntryId.get(l.sourceId)!]),
	);

	const messages = (trace.finalPayload as { messages?: PayloadMessage[] } | undefined)?.messages;
	const grouping =
		Array.isArray(messages) && messages.length > 0
			? groupPayloadForTrace(messages, trace.layers)
			: null;

	const toggleInSet = <T,>(setter: Dispatch<SetStateAction<Set<T>>>, value: T) =>
		setter((prev) => {
			const next = new Set(prev);
			if (next.has(value)) next.delete(value);
			else next.add(value);
			return next;
		});

	// Fallback: no structured payload — render the flat layer list (legacy path).
	if (!grouping) {
		return (
			<FlatLayerList
				layers={trace.layers}
				q={q}
				openLayers={openLayers}
				toggle={(id) => toggleInSet(setOpenLayers, id)}
				formatTokens={formatTokens}
				compact={compact}
			/>
		);
	}

	const historyMessageCount = grouping.history
		.filter((g): g is MessageGroupEntry => g.kind === "messages")
		.reduce((sum, g) => sum + g.count, 0);
	const historyInjectCount = grouping.history.filter((g) => g.kind === "inject").length;
	const recentHistoryLayer = trace.layers.find((l) => l.id === "recent_history");
	const historyTokens = recentHistoryLayer?.tokenCount;

	const visiblePreamble = grouping.preamble.filter((entry) =>
		matches(entry.layer.sourceName, entry.layer.sourceType, entry.layer.sourceId, entry.text),
	);

	// When searching, force-expand the history accordion so matches inside
	// message groups and injects are reachable.
	const effectiveHistoryOpen = historyOpen || q.length > 0;

	return (
		<div className="flex flex-col gap-2">
			<ScriptRunsAccordion runs={trace.scriptInjections} q={q} matches={matches} />
			{visiblePreamble.map((entry) => (
				<LayerCard
					key={entry.layer.id}
					layer={entry.layer}
					expanded={openLayers.has(entry.layer.id)}
					onToggle={() => toggleInSet(setOpenLayers, entry.layer.id)}
					formatTokens={formatTokens}
					compact={compact}
					reason={entry.layer.sourceType === "lore_entry" ? loreReasonByEntryId.get(entry.layer.sourceId) : undefined}
					text={entry.text}
					mergedCount={entry.mergedLayerIds.length}
					mergedNames={entry.mergedNames}
				/>
			))}

			{grouping.hasHistory && (
				<div className="overflow-hidden rounded-md border border-border bg-s2 font-ui">
					<button
						type="button"
						className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-3 text-left active:bg-s3"
						onClick={() => setHistoryOpen(!historyOpen)}
						aria-expanded={effectiveHistoryOpen}
					>
						<span className={cn("text-[11px] text-t4 transition-transform", effectiveHistoryOpen && "rotate-90")}>▶</span>
						<span className="min-w-0 flex-1 font-semibold text-t2">{t("trace_chat_history")}</span>
						<span className="shrink-0 text-[11px] text-t3 tabular-nums">
							{historyMessageCount} {t("trace_messages_label")} · {historyInjectCount} {t("trace_injects_label")}
							{historyTokens != null ? ` · ${formatTokens(historyTokens)}` : ""}
						</span>
					</button>
					<AnimatedDisclosure
						open={effectiveHistoryOpen}
						className="flex flex-col gap-1.5 border-t border-border bg-input-bg p-2.5"
					>
							{grouping.history.map((item) => {
								if (item.kind === "inject") {
									const injectMatchesQ = q.length === 0 || matches(item.text, item.sourceName, item.sourceType);
									if (!injectMatchesQ) return null;
									const injectOpen = openInjects.has(item.layerId) || q.length > 0;
									return (
										<div key={`inj-${item.layerId}`} className="overflow-hidden rounded-md bg-s2/40">
											<button
												type="button"
												className="flex w-full cursor-pointer items-center gap-2 px-1 py-1 text-left font-ui text-[11px] text-t3 active:bg-s3"
												onClick={() => toggleInSet(setOpenInjects, item.layerId)}
												aria-expanded={injectOpen}
											>
												<span className="h-px flex-none bg-border2" style={{ width: 12 }} />
												<span className="min-w-0 truncate font-medium text-t2">{item.sourceName}</span>
												{item.sourceType === "lore_entry" && loreReasonByLayerId.has(item.layerId) && (
													<LoreReasonBadge reason={loreReasonByLayerId.get(item.layerId)!} />
												)}
												<MergedBadge count={item.mergedFrom.length} names={item.mergedFrom.map((r) => r.layerId ?? r.messageId ?? "")} />
												{item.depth != null && <span className="shrink-0 rounded bg-s3 px-1 text-t4">{t("trace_inject_depth", { n: item.depth })}</span>}
												<span className="h-px flex-1 bg-border2" />
												<span className="shrink-0 tabular-nums">{formatTokens(item.tokenCount)}</span>
												<span className={cn("shrink-0 text-[10px] text-t4 transition-transform", injectOpen && "rotate-90")}>▶</span>
											</button>
											<AnimatedDisclosure
												open={injectOpen}
												className="whitespace-pre-wrap border-t border-border2 px-3 py-2 font-mono text-[11px] leading-[1.55] text-t1"
											>
												{item.text}
											</AnimatedDisclosure>
										</div>
									);
								}
								const groupMatchesQ = q.length === 0 || item.messages.some((m) => matches(m.content, m.role));
								if (!groupMatchesQ) return null;
								const expanded = openGroups.has(item.start) || q.length > 0;
								const preview = item.messages[0]?.content ?? "";
								return (
									<div key={`grp-${item.start}`} className="overflow-hidden rounded-md border border-border bg-s2">
										<button
											type="button"
											className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left active:bg-s3"
											onClick={() => toggleInSet(setOpenGroups, item.start)}
											aria-expanded={expanded}
										>
											<span className={cn("text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
											<span className="min-w-0 flex-1 text-[12px] text-t2">
												{item.count > 1
													? t("trace_message_group_range", { start: item.start, end: item.end })
													: t("trace_message_group_one", { n: item.start })}
											</span>
											<span className="min-w-0 flex-1 truncate text-[11px] text-t4">{preview.slice(0, 60)}</span>
										</button>
										<AnimatedDisclosure
											open={expanded}
											className="flex flex-col gap-1.5 border-t border-border bg-input-bg p-2"
										>
												{item.messages.map((m, i) => (
													<div key={m.messageId ?? `${item.start}-${i}`} className="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-t1">
														<span className="mr-1.5 rounded bg-s3 px-1 text-[9px] uppercase text-t3">{m.role}</span>
														<MergedBadge count={m.mergedFrom?.length ?? 0} names={m.mergedFrom?.map((r) => r.layerId ?? r.messageId ?? "")} />
														{m.content}
													</div>
												))}
										</AnimatedDisclosure>
									</div>
								);
							})}
					</AnimatedDisclosure>
				</div>
			)}

			{visiblePreamble.length === 0 && !grouping.hasHistory && (
				<div className="rounded-md border border-dashed border-border2 bg-s2 px-3 py-6 text-center font-ui text-[13px] text-t3">
					{t("trace_no_active")}
				</div>
			)}
		</div>
	);
}

/** Script Runs accordion (P4b) — rendered ABOVE the prompt trace payload so
 *  per-script results (ran/errored, mutations, injected messages, console,
 *  errors) are immediately visible without digging into the trace layers.
 *  Collapsed by default; auto-expands when searching. Gracefully handles
 *  pre-P4 traces (the old single synthetic '__pipeline' row — rendered as a
 *  generic pipeline entry without per-script detail). */
function ScriptRunsAccordion({
	runs,
	q,
	matches,
}: {
	runs: AssemblePromptResponse["scriptInjections"];
	q: string;
	matches: (...vals: Array<unknown>) => boolean;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const [openScripts, setOpenScripts] = useState<Set<string>>(new Set());

	if (runs.length === 0) return null;

	const errorCount = runs.filter((r) => r.status === "errored" || !!r.error).length;
	const effectiveOpen = open || q.length > 0;

	const toggleScript = (id: string) =>
		setOpenScripts((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<div className="overflow-hidden rounded-md border border-border bg-s2 font-ui">
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-3 text-left active:bg-s3"
				onClick={() => setOpen(!open)}
				aria-expanded={effectiveOpen}
			>
				<span className={cn("text-[11px] text-t4 transition-transform", effectiveOpen && "rotate-90")}>▶</span>
				<span className="min-w-0 flex-1 font-semibold text-t2">{t("trace_script_runs")}</span>
				<span className="shrink-0 text-[11px] text-t3 tabular-nums">
					{runs.length}{errorCount > 0 ? ` · ${errorCount} ${t("trace_script_errors_label")}` : ""}
				</span>
			</button>
			<AnimatedDisclosure
				open={effectiveOpen}
				className="flex flex-col gap-1.5 border-t border-border bg-input-bg p-2.5"
			>
				{runs.map((run) => {
					const scriptMatchesQ = q.length === 0 || matches(run.scriptName, run.error, run.personalityMutation, run.scenarioMutation);
					if (!scriptMatchesQ) return null;
					const isExpanded = openScripts.has(run.scriptId) || q.length > 0;
					const errored = run.status === "errored" || !!run.error;
					return (
						<div key={run.scriptId} className="overflow-hidden rounded-md bg-s2/40">
							<button
								type="button"
								className="flex w-full cursor-pointer items-center gap-2 px-1 py-1 text-left font-ui text-[11px] text-t3 active:bg-s3"
								onClick={() => toggleScript(run.scriptId)}
								aria-expanded={isExpanded}
							>
								<span className={cn("shrink-0 text-[10px] text-t4 transition-transform", isExpanded && "rotate-90")}>▶</span>
								<span className="min-w-0 truncate font-medium text-t2">{run.scriptName}</span>
								<span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", errored ? "bg-danger-dim text-danger-text" : "bg-success-dim text-success-text")}>{errored ? t("trace_script_errored") : t("trace_script_ran")}</span>
							</button>
							<AnimatedDisclosure
								open={isExpanded}
								className="flex flex-col gap-1.5 border-t border-border p-2"
							>
								{errored && run.error && (
									<pre className="whitespace-pre-wrap font-mono text-[11px] text-danger-text">{run.error}{run.line ? ` (line ${run.line})` : ""}</pre>
								)}
								{(run.personalityMutation || run.scenarioMutation) && (
									<div className="rounded bg-bg px-2 py-1">
										<div className="mb-0.5 text-[10px] uppercase tracking-wide text-t4">{t("trace_script_mutations")}</div>
										{run.personalityMutation && <pre className="whitespace-pre-wrap font-mono text-[11px] text-t2">{run.personalityMutation}</pre>}
										{run.scenarioMutation && <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] text-t2">{run.scenarioMutation}</pre>}
									</div>
								)}
								{run.injectedMessages && run.injectedMessages.length > 0 && (
									<div className="rounded bg-bg px-2 py-1">
										<div className="mb-0.5 text-[10px] uppercase tracking-wide text-t4">{t("script_test_injected")}</div>
										{run.injectedMessages.map((msg, i) => (
											<div key={i} className="flex items-start gap-1.5">
												<span className="shrink-0 rounded bg-s3 px-1 py-0.5 font-mono text-[10px] uppercase text-t3">{msg.role}</span>
												<pre className="flex-1 whitespace-pre-wrap font-mono text-[11px] text-t2">{msg.content}</pre>
											</div>
										))}
									</div>
								)}
								{run.console && run.console.length > 0 && (
									<div className="rounded bg-bg px-2 py-1">
										<div className="mb-0.5 text-[10px] uppercase tracking-wide text-t4">{t("script_test_console")}</div>
										{run.console.map((entry, i) => (
											<div key={i} className="flex items-start gap-1.5">
												<span className={cn("shrink-0 rounded px-1 py-0.5 font-mono text-[10px] uppercase", entry.level === "error" ? "bg-danger-dim text-danger-text" : entry.level === "warn" ? "bg-s3 text-t2" : "bg-s3 text-t3")}>{entry.level}</span>
												<pre className="flex-1 whitespace-pre-wrap font-mono text-[11px] text-t2">{entry.args}</pre>
											</div>
										))}
									</div>
								)}
							</AnimatedDisclosure>
						</div>
					);
				})}
			</AnimatedDisclosure>
		</div>
	);
}

/** A single collapsible layer card (preamble or legacy flat-list item). */
function LayerCard({
	layer,
	expanded,
	onToggle,
	formatTokens,
	compact = false,
	reason,
	text,
	mergedCount,
	mergedNames,
}: {
	layer: PromptLayerDto;
	expanded: boolean;
	onToggle: () => void;
	formatTokens: (n: number) => string;
	compact?: boolean;
	/** Lore-activation reason badge (only for lore_entry layers). */
	reason?: LoreActivationReason;
	/** Payload-faithful content override (the merged entry's own text). */
	text?: string;
	/** Absorbed-layer count — renders the merged badge when > 0. */
	mergedCount?: number;
	/** Display names of the absorbed layers (badge tooltip). */
	mergedNames?: string[];
}) {
	const isPreset = layer.sourceType === "prompt_preset";
	const isRetrieval = layer.sourceType.includes("memory") || layer.sourceType === "lore_entry";
	return (
		<div
			className={cn(
				"overflow-hidden rounded-md border border-border bg-s2 font-ui",
				isPreset && "border-l-2 border-l-info",
				isRetrieval && "border-l-2 border-l-success",
				!isPreset && !isRetrieval && "border-l-2 border-l-danger",
			)}
		>
			{compact ? (
				<button
					type="button"
					className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2 text-left text-xs active:bg-s3"
					onClick={onToggle}
					aria-expanded={expanded}
				>
					<div className="flex min-w-0 items-baseline gap-1.5">
						<span className="shrink-0 font-semibold text-t2">{layer.sourceName ?? layer.sourceType}</span>
						{reason && <LoreReasonBadge reason={reason} />}
						{mergedCount != null && mergedCount > 0 && <MergedBadge count={mergedCount} names={mergedNames} />}
						<span className="min-w-0 truncate text-t4">{layer.sourceId || layer.sourceType}</span>
					</div>
					<div className="flex shrink-0 items-center gap-1.5 text-t3">
						<span className="tabular-nums">{formatTokens(layer.tokenCount)}</span>
						<span className={cn("text-[10px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
					</div>
				</button>
			) : (
				<button
					type="button"
					className="flex w-full cursor-pointer flex-col px-3.5 py-3 text-left active:bg-s3"
					onClick={onToggle}
					aria-expanded={expanded}
				>
					<div className="flex min-w-0 items-center gap-2">
						<div className="min-w-0 flex-1 font-semibold text-t2">{layer.sourceName ?? layer.sourceType}</div>
						{reason && <LoreReasonBadge reason={reason} />}
						{mergedCount != null && mergedCount > 0 && <MergedBadge count={mergedCount} names={mergedNames} />}
						<span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
					</div>
					<div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-t3">
						<span className="min-w-0 flex-1 truncate">{layer.sourceId || layer.sourceType}</span>
						<span className="shrink-0 tabular-nums">{formatTokens(layer.tokenCount)}</span>
					</div>
				</button>
			)}
			<AnimatedDisclosure
				open={expanded}
				className="whitespace-pre-wrap border-t border-border bg-input-bg p-3 font-mono text-[11px] leading-[1.55] text-t1"
			>
				{text ?? layer.text}
			</AnimatedDisclosure>
		</div>
	);
}

/** Legacy fallback: flat priority-sorted layer list (when no structured payload). */
function FlatLayerList({
	layers,
	q,
	openLayers,
	toggle,
	formatTokens,
	compact = false,
}: {
	layers: PromptLayerDto[];
	q: string;
	openLayers: Set<string>;
	toggle: (id: string) => void;
	formatTokens: (n: number) => string;
	compact?: boolean;
}) {
	const { t } = useT();
	const matchesQ = (...vals: Array<unknown>) =>
		!q || vals.filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
	const visible = layers.filter((layer) =>
		matchesQ(layer.sourceName, layer.sourceType, layer.sourceId, layer.text),
	);
	if (visible.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-border2 bg-s2 px-3 py-6 text-center font-ui text-[13px] text-t3">
				{t("trace_no_active")}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{visible.map((layer) => (
				<LayerCard
					key={layer.id}
					layer={layer}
					expanded={openLayers.has(layer.id)}
					onToggle={() => toggle(layer.id)}
					formatTokens={formatTokens}
					compact={compact}
				/>
			))}
		</div>
	);
}
