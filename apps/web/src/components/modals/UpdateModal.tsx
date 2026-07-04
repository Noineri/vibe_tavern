import { useEffect, useState } from "react";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { Markdown } from "../../lib/markdown.js";
import { useUpdateFlow } from "../../hooks/use-update-flow.js";
import { useModalStore } from "../../stores/index.js";
import { fetchRuntimeInfo, type RuntimeInfo } from "../../api/runtime-api.js";

interface UpdateModalProps {
	latestVersion: string | null;
	latestTag: string | null;
	releaseUrl: string | null;
	releaseNotes: string | null;
}

const PHASE_LABELS: Record<string, string> = {
	idle: "Idle",
	checking: "Checking for update",
	"downloading-archive": "Downloading release archive",
	"downloading-sums": "Downloading checksums",
	verifying: "Verifying checksum",
	extracting: "Extracting archive",
	swapping: "Installing",
	"spawning-restart": "Preparing to restart",
	exiting: "Stopping server",
	done: "Done",
	error: "Error",
};

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function GitHubFallbackButton({ releaseUrl }: { releaseUrl: string }) {
	const { t } = useT();
	return (
		<button
			type="button"
			className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-[filter] hover:brightness-110"
			onClick={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}
		>
			<Icons.globe />
			{t("update_modal_open_release_page")}
		</button>
	);
}

export function UpdateModal({ latestVersion, latestTag, releaseUrl, releaseNotes }: UpdateModalProps) {
	const { t } = useT();
	const open = useModalStore((s) => s.isUpdateModalOpen);
	const setOpen = useModalStore((s) => s.setUpdateModalOpen);
	const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
	const flow = useUpdateFlow(latestVersion);

	useEffect(() => {
		if (!open) return;
		void (async () => {
			try {
				setRuntimeInfo(await fetchRuntimeInfo());
			} catch {
				setRuntimeInfo(null);
			}
		})();
	}, [open]);

	useEffect(() => {
		if (!open && flow.state.kind !== "idle" && flow.state.kind !== "complete") {
			void flow.reset();
		}
	}, [open, flow]);

	if (!open) return null;

	const tag = latestTag ?? (latestVersion ? `v${latestVersion}` : "");
	const headerLabel = tag ? t("update_modal_release_header").replace("{tag}", tag) : t("update_modal_new_version_available");

	const canSelfUpdate = runtimeInfo?.canSelfUpdate ?? false;
	const showConfirm = flow.state.kind === "idle";
	const showReleaseNotes = showConfirm && Boolean(releaseNotes);

	const onClose = () => {
		if (flow.state.kind === "running") return;
		setOpen(false);
	};

	return (
		<Modal open={open} onClose={onClose} compact title={headerLabel} description="Vibe Tavern self-update">
			<div className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col rounded-lg border border-border2 bg-surface shadow-xl">
				{/* Header */}
				<div className="flex items-center justify-between border-b border-border2 px-5 py-3.5">
					<div className="flex items-center gap-2.5">
						<span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-dim text-accent-t">
							<Icons.arrowUpCircle />
						</span>
						<h2 className="font-ui text-[calc(var(--ui-fs)+1px)] font-semibold text-t1">{headerLabel}</h2>
					</div>
					{flow.state.kind !== "running" && (
						<button type="button" onClick={onClose} className="text-t3 hover:text-t1"><Icons.close /></button>
					)}
				</div>

				{/* Body */}
				<div className="flex-1 overflow-y-auto px-5 py-4">
					{flow.state.kind === "idle" && (
						<>
							{showReleaseNotes ? (
								<div className="md-content-plain max-h-[40vh] overflow-y-auto rounded-md border border-border2 bg-s1 p-3.5 text-[calc(var(--ui-fs)-1px)] leading-relaxed text-t2">
									<Markdown text={releaseNotes ?? ""} variant="plain" />
								</div>
							) : (
								<p className="text-[calc(var(--ui-fs)-1px)] text-t2">{t("update_modal_no_notes")}</p>
							)}
							{!canSelfUpdate && (
								<p className="mt-3 rounded-md bg-s2 px-3 py-2 text-[calc(var(--ui-fs)-2px)] text-t3">
									{t("update_modal_self_update_unavailable")}
								</p>
							)}
						</>
					)}

					{flow.state.kind === "running" && (
						<RunningView phaseLabel={PHASE_LABELS[flow.state.phase] ?? flow.state.phase} progress={flow.state.progress} />
					)}

					{flow.state.kind === "complete" && (
						<div className="flex flex-col items-center gap-3 py-4 text-center">
							<span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-dim text-success-text">
								<Icons.check />
							</span>
							<p className="text-[calc(var(--ui-fs)+0px)] font-medium text-t1">
								{t("update_modal_complete").replace("{version}", flow.state.newVersion)}
							</p>
							<p className="max-w-[420px] text-[calc(var(--ui-fs)-2px)] text-t3">
								{t("update_modal_restart_instructions")}
							</p>
						</div>
					)}

					{flow.state.kind === "error" && (
						<ErrorView
							failureKind={flow.state.failureKind}
							message={flow.state.message}
							stack={flow.state.stack}
							raw={flow.state.raw}
							releaseUrl={releaseUrl ?? ""}
							labels={{
								titleSoft: t("update_modal_error_soft_title"),
								titleFatal: t("update_modal_error_fatal_title"),
								details: t("update_modal_error_details"),
								redownload: t("update_modal_redownload"),
							}}
						/>
					)}
				</div>

				{/* Actions */}
				<div className="flex items-center justify-end gap-2 border-t border-border2 px-5 py-3">
					{flow.state.kind === "idle" && (
						<>
							<button
								type="button"
								className="rounded px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s2 hover:text-t1"
								onClick={onClose}
							>
								{t("update_modal_cancel")}
							</button>
							{canSelfUpdate ? (
								<button
									type="button"
									className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-[filter] hover:brightness-110"
									onClick={() => void flow.start()}
								>
									<Icons.download />
									{t("update_modal_update_button")}
								</button>
							) : releaseUrl ? (
								<GitHubFallbackButton releaseUrl={releaseUrl} />
							) : null}
						</>
					)}

					{flow.state.kind === "complete" && (
						<button
							type="button"
							className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-[filter] hover:brightness-110"
							onClick={() => setOpen(false)}
						>
							{t("update_modal_close")}
						</button>
					)}

					{flow.state.kind === "error" && (
						<>
							<button
								type="button"
								className="rounded px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s2 hover:text-t1"
								onClick={onClose}
							>
								{t("update_modal_dismiss")}
							</button>
							{flow.state.failureKind === "soft" && (
								<button
									type="button"
									className="rounded-md bg-accent px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent hover:brightness-110"
									onClick={() => void flow.retry()}
								>
									{t("update_modal_retry")}
								</button>
							)}
						</>
					)}
				</div>
			</div>
		</Modal>
	);
}

function RunningView({
	phaseLabel,
	progress,
}: {
	phaseLabel: string;
	progress: { receivedBytes: number; totalBytes: number | null } | null;
}) {
	const pct =
		progress && progress.totalBytes && progress.totalBytes > 0
			? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
			: null;
	return (
		<div className="flex flex-col gap-3 py-2">
			<div className="flex items-center gap-2.5">
				<span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
				<span className="text-[calc(var(--ui-fs)-1px)] text-t1">{phaseLabel}…</span>
			</div>
			{pct !== null && (
				<div>
					<div className="mb-1 flex justify-between text-[calc(var(--ui-fs)-3px)] text-t3">
						<span>{pct}%</span>
						<span>
							{formatBytes(progress!.receivedBytes)} / {formatBytes(progress!.totalBytes!)}
						</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-s3">
						<div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
					</div>
				</div>
			)}
			{pct === null && progress !== null && (
				<div className="text-[calc(var(--ui-fs)-3px)] text-t3">{formatBytes(progress.receivedBytes)}</div>
			)}
		</div>
	);
}

function ErrorView({
	failureKind,
	message,
	stack,
	raw,
	releaseUrl,
	labels,
}: {
	failureKind: "soft" | "fatal";
	message: string;
	stack: string | null;
	raw: string | null;
	releaseUrl: string;
	labels: { titleSoft: string; titleFatal: string; details: string; redownload: string };
}) {
	const isFatal = failureKind === "fatal";
	const title = isFatal ? labels.titleFatal : labels.titleSoft;
	const detail = stack ?? raw ?? null;
	return (
		<div className="flex flex-col gap-3 py-2">
			<div className={`flex items-start gap-2.5 rounded-md ${isFatal ? "bg-danger-dim" : "bg-s2"} px-3 py-2.5`}>
				<span className={`mt-0.5 ${isFatal ? "text-danger-text" : "text-t2"}`}><Icons.alert /></span>
				<div className="flex-1">
					<div className={`text-[calc(var(--ui-fs)-1px)] font-semibold ${isFatal ? "text-danger-text" : "text-t1"}`}>{title}</div>
					<div className="mt-0.5 text-[calc(var(--ui-fs)-2px)] text-t2">{message}</div>
				</div>
			</div>
			{detail && (
				<details className="rounded-md border border-border2 bg-s1">
					<summary className="cursor-pointer px-3 py-1.5 text-[calc(var(--ui-fs)-3px)] text-t3 hover:text-t1">{labels.details}</summary>
					<pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all px-3 pb-3 font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{detail}</pre>
				</details>
			)}
			{isFatal && releaseUrl && (
				<button
					type="button"
					className="flex items-center justify-center gap-2 rounded-md border border-border2 bg-s2 px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-t1 hover:bg-s3"
					onClick={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}
				>
					<Icons.globe />
					{labels.redownload}
				</button>
			)}
		</div>
	);
}
