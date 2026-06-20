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
import type { AssemblePromptResponse, PromptLayerDto } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";

/** One entry of `finalPayload.messages`. Content may be a string or a vision part-array. */
export interface PayloadMessage {
	role?: string;
	content?: unknown;
	layerId?: string;
	messageId?: string;
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
}

/** A run of consecutive chat messages between two dividers. */
export interface MessageGroupEntry {
	kind: "messages";
	/** 1-based display index of the first message in this group (within history). */
	start: number;
	/** 1-based display index of the last message in this group. */
	end: number;
	count: number;
	messages: Array<{ role: string; content: string; messageId?: string }>;
}

export interface PayloadGrouping {
	/** Preamble layer cards (leading `layerId` entries before any chat message). */
	preamble: PromptLayerDto[];
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
	const preamble = preambleRaw
		.map((m) => (m.layerId ? layerMap.get(m.layerId) : undefined))
		.filter((l): l is PromptLayerDto => Boolean(l));

	const historyRegion = hasHistory ? messages.slice(firstMsgIdx) : [];
	const history: Array<InjectEntry | MessageGroupEntry> = [];

	let currentRun: Array<{ role: string; content: string; messageId?: string }> = [];
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
				text: layer?.text ?? contentToString(entry.content),
			});
		} else if (entry.messageId) {
			msgCounter += 1;
			if (currentRun.length === 0) runStart = msgCounter;
			currentRun.push({
				role: entry.role ?? "system",
				content: contentToString(entry.content),
				messageId: entry.messageId,
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

	const visiblePreamble = grouping.preamble.filter((layer) =>
		matches(layer.sourceName, layer.sourceType, layer.sourceId, layer.text),
	);

	// When searching, force-expand the history accordion so matches inside
	// message groups and injects are reachable.
	const effectiveHistoryOpen = historyOpen || q.length > 0;

	return (
		<div className="flex flex-col gap-2">
			{visiblePreamble.map((layer) => (
				<LayerCard
					key={layer.id}
					layer={layer}
					expanded={openLayers.has(layer.id)}
					onToggle={() => toggleInSet(setOpenLayers, layer.id)}
					formatTokens={formatTokens}
					compact={compact}
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
					{effectiveHistoryOpen && (
						<div className="flex flex-col gap-1.5 border-t border-border bg-input-bg p-2.5">
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
												{item.depth != null && <span className="shrink-0 rounded bg-s3 px-1 text-t4">{t("trace_inject_depth").replace("{n}", String(item.depth))}</span>}
												<span className="h-px flex-1 bg-border2" />
												<span className="shrink-0 tabular-nums">{formatTokens(item.tokenCount)}</span>
												<span className={cn("shrink-0 text-[10px] text-t4 transition-transform", injectOpen && "rotate-90")}>▶</span>
											</button>
											{injectOpen && (
												<div className="whitespace-pre-wrap border-t border-border2 px-3 py-2 font-mono text-[11px] leading-[1.55] text-t1">
													{item.text}
												</div>
											)}
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
													? t("trace_message_group_range").replace("{start}", String(item.start)).replace("{end}", String(item.end))
													: t("trace_message_group_one").replace("{n}", String(item.start))}
											</span>
											<span className="min-w-0 flex-1 truncate text-[11px] text-t4">{preview.slice(0, 60)}</span>
										</button>
										{expanded && (
											<div className="flex flex-col gap-1.5 border-t border-border bg-input-bg p-2">
												{item.messages.map((m, i) => (
													<div key={m.messageId ?? `${item.start}-${i}`} className="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-t1">
														<span className="mr-1.5 rounded bg-s3 px-1 text-[9px] uppercase text-t3">{m.role}</span>
														{m.content}
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
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

/** A single collapsible layer card (preamble or legacy flat-list item). */
function LayerCard({
	layer,
	expanded,
	onToggle,
	formatTokens,
	compact = false,
}: {
	layer: PromptLayerDto;
	expanded: boolean;
	onToggle: () => void;
	formatTokens: (n: number) => string;
	compact?: boolean;
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
						<span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
					</div>
					<div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-t3">
						<span className="min-w-0 flex-1 truncate">{layer.sourceId || layer.sourceType}</span>
						<span className="shrink-0 tabular-nums">{formatTokens(layer.tokenCount)}</span>
					</div>
				</button>
			)}
			{expanded && (
				<div className="whitespace-pre-wrap border-t border-border bg-input-bg p-3 font-mono text-[11px] leading-[1.55] text-t1">
					{layer.text}
				</div>
			)}
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
