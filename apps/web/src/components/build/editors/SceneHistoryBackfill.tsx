/**
 * Scene history backfill UI (SCN-15) — Build → Insights → Scene → History.
 *
 * Starts a server-authoritative run (`scene_backfill_runs`, SCN-14) that
 * regenerates Scene state across the active branch's assistant messages,
 * oldest-to-newest, sequentially. The run is durable and server-owned: the
 * client only drives start/status/cancel/retry and polls typed status. Mode is
 * `fill-missing` (default — skip variants that already carry a current record)
 * or `rebuild` (regenerate all).
 *
 * Before starting the client shows the call count for the chosen mode: rebuild
 * bills every assistant message in the active branch; fill-missing bills only
 * those whose selected variant has no Scene record yet
 * (AppMessage.sceneTracker === null). Plus a warning when the count is large,
 * and a conditional monetary estimate shown ONLY when the resolved model
 * carries pricing metadata (output $/Mtok × the count × a per-call token
 * budget). No pricing → count only.
 *
 * Reload reattachment: the active runId is persisted to localStorage keyed by
 * chat; on mount the component re-polls it (reattaching a same-client reload,
 * while a server restart is resume-safe via the SCN-14 status poll). Generated
 * records land on the variants server-side, so on a terminal transition the
 * component refreshes the snapshot to pull them into the header zones.
 *
 * Reuses shared primitives + field styles (AGENTS.md §9). No bespoke inputs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import type { SceneBackfillMode, SceneBackfillStatusResponse } from "../../../api/types.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import {
	startSceneBackfillAction,
	getSceneBackfillStatusAction,
	cancelSceneBackfillAction,
	retrySceneBackfillAction,
	fetchChatAction,
} from "../../../stores/api-actions/chat-actions.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { lblCls } from "../fields/field-styles.js";
import { useT } from "../../../i18n/context.js";
import { SCENE_BACKFILL_MODE } from "@vibe-tavern/domain";

/** Conservative upper bound for a single Scene generation's output tokens — a
 *  small structured JSON object. Drives the conditional cost estimate. */
const OUTPUT_BUDGET_TOKENS = 600;
/** Status poll interval while a run is pending/running. */
const POLL_MS = 2500;
/** Count above which a "this may take a while" warning is shown. */
const WARN_THRESHOLD = 30;

type RunStatus = SceneBackfillStatusResponse["status"];
function isTerminal(s: RunStatus): boolean {
	return s === "completed" || s === "cancelled" || s === "failed";
}
function storageKey(chatId: string): string {
	return `vt:scene-backfill:${chatId}`;
}

export function SceneHistoryBackfill({ chatId }: { chatId: ChatId }) {
	const { t } = useT();

	// ── Primitive selectors (render-isolation). assistantCount is a number so the
	//    card only re-renders when the count actually changes, not on every edit. ──
	const tracker = useSnapshotStore((s) => s.activeChat?.insightsConfig?.tracker ?? null);
	const assistantCount = useSnapshotStore((s) =>
		s.messageOrder.reduce((n, id) => n + (s.messagesById[id]?.role === "assistant" ? 1 : 0), 0),
	);
	// Assistant messages whose selected variant has no Scene record — the exact
	// set fill-missing will (re)generate. AppMessage.sceneTracker mirrors the
	// selected variant's record (null when absent); rebuild regenerates all, so
	// it stays on assistantCount.
	const missingSceneCount = useSnapshotStore((s) =>
		s.messageOrder.reduce(
			(n, id) => n + (s.messagesById[id]?.role === "assistant" && !s.messagesById[id]?.sceneTracker ? 1 : 0),
			0,
		),
	);
	const profiles = useProviderDataStore((s) => s.profiles);

	const [mode, setMode] = useState<SceneBackfillMode>(SCENE_BACKFILL_MODE.fillMissing);
	const [status, setStatus] = useState<SceneBackfillStatusResponse | null>(null);
	const [busy, setBusy] = useState(false);
	const [pricing, setPricing] = useState<{ input?: number; output?: number } | null>(null);

	// Resolve the effective provider+model from the SAVED config (what the server
	// will actually use), mirroring SceneModelSelector's resolution.
	const { profileId, modelId } = useMemo(() => {
		if (!tracker) return { profileId: "", modelId: "" };
		const active = profiles.find((p) => p.isActive) ?? profiles[0] ?? null;
		const pid = tracker.useChatModel ? (active?.id ?? "") : (tracker.providerProfileId ?? "");
		const profile = profiles.find((p) => p.id === pid) ?? null;
		const mid = (tracker.useChatModel ? (profile?.defaultModel ?? "") : (tracker.model ?? profile?.defaultModel ?? "")).trim();
		return { profileId: pid, modelId: mid };
	}, [tracker, profiles]);

	// Fetch model metadata for pricing (estimate is conditional on it being known).
	useEffect(() => {
		if (!profileId || !modelId) { setPricing(null); return; }
		let cancelled = false;
		fetchProviderModelsAction(profileId)
			.then((res) => { if (!cancelled) setPricing(res.models.find((m) => m.id === modelId)?.pricing ?? null); })
			.catch(() => { if (!cancelled) setPricing(null); });
		return () => { cancelled = true; };
	}, [profileId, modelId]);

	// Mode-aware call count: fill-missing bills only messages that lack a Scene;
	// rebuild bills every assistant message.
	const effectiveCount = mode === SCENE_BACKFILL_MODE.fillMissing ? missingSceneCount : assistantCount;
	const nothingToDo = effectiveCount === 0;
	const emptyState = assistantCount === 0;
	const estimate = useMemo(() => {
		if (!pricing?.output || !effectiveCount) return null;
		return (effectiveCount * OUTPUT_BUDGET_TOKENS / 1e6) * pricing.output;
	}, [pricing, effectiveCount]);

	const running = !!status && (status.status === "pending" || status.status === "running");

	// ── Reload reattachment: on mount, re-poll a persisted runId. ──
	useEffect(() => {
		const runId = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey(chatId)) : null;
		if (!runId) return;
		let cancelled = false;
		void (async () => {
			try {
				const s = await getSceneBackfillStatusAction(chatId, runId);
				if (cancelled) return;
				if (isTerminal(s.status)) {
					localStorage.removeItem(storageKey(chatId));
					try { await fetchChatAction(chatId); } catch { /* records already persisted */ }
				}
				setStatus(s);
			} catch {
				// Run gone (server data loss / old key) — drop it and show the start form.
				if (!cancelled) localStorage.removeItem(storageKey(chatId));
			}
		})();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatId]);

	// ── Polling: while pending/running, schedule the next status fetch. Each poll
	//    sets a fresh status (new object identity) which re-triggers this effect,
	//    yielding a steady POLL_MS cadence. Terminal → stop + refresh snapshot. ──
	useEffect(() => {
		if (!running || !status) return;
		const runId = status.runId;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const next = await getSceneBackfillStatusAction(chatId, runId);
					setStatus(next);
					if (isTerminal(next.status)) {
						localStorage.removeItem(storageKey(chatId));
						try { await fetchChatAction(chatId); } catch { /* generated records already persisted */ }
					}
				} catch {
					/* transient — next tick retries */
				}
			})();
		}, POLL_MS);
		return () => clearTimeout(timer);
	}, [running, status, chatId]);

	async function start() {
		setBusy(true);
		try {
			const s = await startSceneBackfillAction(chatId, mode);
			localStorage.setItem(storageKey(chatId), s.runId);
			setStatus(s);
			if (isTerminal(s.status)) {
				localStorage.removeItem(storageKey(chatId));
				try { await fetchChatAction(chatId); } catch { /* empty manifest — nothing generated */ }
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("scn_hist_failed_toast"));
		} finally {
			setBusy(false);
		}
	}

	async function cancel() {
		if (!status) return;
		setBusy(true);
		try {
			const s = await cancelSceneBackfillAction(chatId, status.runId);
			setStatus(s);
			if (isTerminal(s.status)) {
				localStorage.removeItem(storageKey(chatId));
				try { await fetchChatAction(chatId); } catch { /* keep */ }
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("scn_hist_failed_toast"));
		} finally {
			setBusy(false);
		}
	}

	async function retry() {
		if (!status) return;
		setBusy(true);
		try {
			const s = await retrySceneBackfillAction(chatId, status.runId);
			localStorage.setItem(storageKey(chatId), s.runId);
			setStatus(s); // running again → polling effect resumes
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("scn_hist_failed_toast"));
		} finally {
			setBusy(false);
		}
	}

	function newRun() {
		localStorage.removeItem(storageKey(chatId));
		setStatus(null);
	}

	// ── Idle: the start form (mode + count + warning + estimate + Start). ──
	if (!status) {
		return (
			<div className="space-y-3">
				<div>
					<label className={lblCls}>{t("scn_hist_mode_label")}</label>
					<div className="mt-1.5 flex gap-1.5">
						{([SCENE_BACKFILL_MODE.fillMissing, SCENE_BACKFILL_MODE.rebuild] as const).map((m) => (
							<button
								key={m}
								type="button"
								onClick={() => setMode(m)}
								className={cn(
									"flex-1 rounded-md border px-3 py-1.5 font-ui text-[12px] transition-colors",
									mode === m ? "border-accent bg-accent-dim text-accent" : "border-border2 bg-s2 text-t3 hover:border-accent",
								)}
							>
								{t(m === SCENE_BACKFILL_MODE.fillMissing ? "scn_hist_mode_fill" : "scn_hist_mode_rebuild")}
							</button>
						))}
					</div>
					<p className="mt-1.5 font-ui text-[10px] leading-relaxed text-t4">
						{t(mode === SCENE_BACKFILL_MODE.fillMissing ? "scn_hist_mode_fill_hint" : "scn_hist_mode_rebuild_hint")}
					</p>
				</div>

				{nothingToDo ? (
					<p className="font-ui text-[11px] text-t4">
						{t(emptyState ? "scn_hist_no_messages" : "scn_hist_all_have_scene")}
					</p>
				) : (
					<>
						<p className="font-ui text-[11px] text-t3">
							{t(mode === SCENE_BACKFILL_MODE.fillMissing ? "scn_hist_count_fill" : "scn_hist_count_rebuild", { n: effectiveCount })}
						</p>
						{effectiveCount > WARN_THRESHOLD && (
							<p className="flex items-start gap-1.5 font-ui text-[11px] leading-relaxed text-warning-text">
								<span className="mt-px shrink-0"><Ic.alert /></span>
								<span>{t("scn_hist_warning", { n: effectiveCount })}</span>
							</p>
						)}
						{estimate !== null && (
							<p className="font-ui text-[11px] text-t4">
								{t("scn_hist_estimate", { cost: estimate.toFixed(estimate < 1 ? 3 : 2) })}
							</p>
						)}
					</>
				)}

				<button
					type="button"
					onClick={() => void start()}
					disabled={nothingToDo || busy}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-ui text-[12px] font-medium transition-opacity disabled:opacity-40",
						"bg-accent text-on-accent hover:opacity-90",
					)}
				>
					{busy ? <Spinner /> : <Ic.sparkles />}
					{t("scn_hist_start")}
				</button>
			</div>
		);
	}

	// ── Running: progress + current target + Cancel. ──
	if (running) {
		const pct = status.total > 0 ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
		return (
			<div className="space-y-2.5">
				<div className="flex items-center justify-between font-ui text-[11px] text-t3">
					<span className="flex items-center gap-1.5"><Spinner /> {t("scn_hist_running")}</span>
					<span className="tabular-nums text-t4">{t("scn_hist_progress", { processed: status.processed, total: status.total })}</span>
				</div>
				<div className="h-1.5 overflow-hidden rounded-full bg-s3" role="progressbar" aria-valuenow={status.processed} aria-valuemin={0} aria-valuemax={status.total}>
					<div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
				</div>
				<div className="flex items-center justify-between">
					<span className="font-ui text-[10px] text-t4">{status.current ? t("scn_hist_current", { n: status.processed + 1 }) : ""}</span>
					<button
						type="button"
						onClick={() => void cancel()}
						disabled={busy}
						className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-2.5 py-1 font-ui text-[11px] text-t2 transition-colors hover:border-danger disabled:opacity-40"
					>
						<Ic.close />
						{t("scn_hist_cancel")}
					</button>
				</div>
			</div>
		);
	}

	// ── Terminal: partial summary + Retry + New run. ──
	const sum = status.summary;
	const failedCount = sum?.failed ?? 0;
	const showRetry = failedCount > 0 || status.status === "cancelled" || status.status === "failed";
	return (
		<div className="space-y-2.5">
			<p className="flex items-center gap-1.5 font-ui text-[11px] font-medium text-t3">
				<span className={cn(
					"shrink-0",
					status.status === "completed" ? "text-success-text" : status.status === "cancelled" ? "text-t4" : "text-danger-text",
				)}>
					{status.status === "completed" ? <Ic.checkCircle /> : status.status === "failed" ? <Ic.alert /> : <Ic.close />}
				</span>
				{t(`scn_hist_status_${status.status}` as const)}
			</p>
			{sum && (
				<div className="flex flex-wrap gap-x-3 gap-y-1 font-ui text-[11px] text-t4">
					<span className="text-success-text">{t("scn_hist_succeeded", { n: sum.succeeded })}</span>
					{sum.skipped > 0 && <span>{t("scn_hist_skipped", { n: sum.skipped })}</span>}
					{sum.failed > 0 && <span className="text-danger-text">{t("scn_hist_failed", { n: sum.failed })}</span>}
				</div>
			)}
			<div className="flex items-center gap-2">
				{showRetry && (
					<button
						type="button"
						onClick={() => void retry()}
						disabled={busy}
						className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-2.5 py-1 font-ui text-[11px] text-t2 transition-colors hover:border-accent disabled:opacity-40"
					>
						{busy ? <Spinner /> : <Ic.regen />}
						{t("scn_hist_retry")}
					</button>
				)}
				<button
					type="button"
					onClick={newRun}
					className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-ui text-[11px] text-t3 transition-colors hover:bg-s2"
				>
					<Ic.plus />
					{t("scn_hist_new")}
				</button>
			</div>
		</div>
	);
}

function Spinner() {
	return <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}
