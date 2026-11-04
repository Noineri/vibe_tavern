import { useRef, useSyncExternalStore } from "react";
import { useT } from "../../i18n/context.js";
import type Resources from "../../i18n/resources.js";
import { Markdown } from "../../lib/markdown.js";
import { formatBytes } from "../../lib/format-bytes.js";
import { cleanReleaseNotes } from "../../lib/version-check.js";
import { useUpdateCheck } from "../../hooks/use-update-check.js";
import { useUpdateFlow } from "../../hooks/use-update-flow.js";
import { fetchUpdateCheck, type RuntimeInfo, type RuntimeUpdateCheck, type RuntimeUpdatePhase } from "../../api/runtime-api.js";
import * as buildConfig from "../../build-config.js";
import { Icons } from "../shared/icons.js";
import { useSettingsSectionLeaveGuard } from "./settings-section-lifecycle.js";

// Moved from modals/UpdateModal.tsx (SM-5): the update body lives in the
// About settings section. The modal shell, its store flag and its header
// chrome are gone; the flow views below are the moved originals.

const PHASE_I18N_KEYS: Record<RuntimeUpdatePhase, keyof Resources["en"]> = {
  idle: "update_modal_phase_idle",
  checking: "update_modal_phase_checking",
  preflight: "update_modal_phase_preflight",
  "downloading-archive": "update_modal_phase_downloading_archive",
  "downloading-sums": "update_modal_phase_downloading_sums",
  verifying: "update_modal_phase_verifying",
  extracting: "update_modal_phase_extracting",
  swapping: "update_modal_phase_swapping",
  "installing-package": "update_modal_phase_installing_package",
  done: "update_modal_phase_done",
  error: "update_modal_phase_error",
};

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
        <details className="rounded-md border border-border2">
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

/** One server-check press; the boot badge check is a separate cached source. */
type CheckState =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "verdict"; value: RuntimeUpdateCheck }
  | { kind: "failed" };

// Module-scoped like the flow state (defect 2026-11-04): a desktop→mobile
// breakpoint cross remounts the whole section — the pressed check's verdict
// must survive it instead of snapping back to the idle button.
let checkState: CheckState = { kind: "unchecked" };
const checkListeners = new Set<() => void>();

function emitCheck(next: CheckState): void {
  checkState = next;
  for (const listener of checkListeners) listener();
}

function useCheckState(): [CheckState, (next: CheckState) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      checkListeners.add(listener);
      return () => {
        checkListeners.delete(listener);
      };
    },
    () => checkState,
  );
  return [value, emitCheck];
}

/** Test seam — production never calls this. */
export function __resetAboutCheckStateForTests(): void {
  emitCheck({ kind: "unchecked" });
}

/** Everything the release view needs, derived once from either source. */
interface ReleaseView {
  latestTag: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  canSelfUpdate: boolean;
}

export function AboutUpdateBlock({ runtimeInfo }: { runtimeInfo: RuntimeInfo | null }) {
  const { t } = useT();
  const [check, emitCheck] = useCheckState();
  // The AppShell badge check runs off the same localStorage-cached source, so
  // this second instance resolves instantly and adds no GitHub traffic; it
  // only makes an already-known update visible without a manual press.
  const bootUpdate = useUpdateCheck(buildConfig.APP_VERSION);

  const verdict = check.kind === "verdict" ? check.value : null;
  const expectedVersion = verdict?.latestVersion ?? (bootUpdate.hasUpdate ? bootUpdate.latestVersion : null);
  const flow = useUpdateFlow(expectedVersion);

  // Non-dismissable states ("running" — the swap is rewriting the install
  // directory; "complete" — the server has exited and never comes back) must
  // block close, section change and mobile Back: same law the modal shell
  // enforced by refusing onClose. Refuse to call the continuation.
  const flowKindRef = useRef(flow.state.kind);
  flowKindRef.current = flow.state.kind;
  const flowResetRef = useRef(flow.reset);
  flowResetRef.current = flow.reset;
  useSettingsSectionLeaveGuard((continueLeaving) => {
    const kind = flowKindRef.current;
    if (kind === "running" || kind === "complete") return;
    // Leaving the error state cleared the server orchestrator in the old
    // modal (reset on close). A guard-approved leave IS that close — while a
    // viewport-cross remount never passes through here, keeping the error
    // view alive for the remounted section to pick back up.
    if (kind === "error") void flowResetRef.current();
    // Same fidelity for the pressed check: a real leave reopens fresh (the
    // old modal was state-per-open); only the guard-less remount keeps it.
    emitCheck({ kind: "unchecked" });
    continueLeaving();
  });

  const runCheck = async () => {
    emitCheck({ kind: "checking" });
    try {
      emitCheck({ kind: "verdict", value: await fetchUpdateCheck() });
    } catch {
      emitCheck({ kind: "failed" });
    }
  };

  // The release view appears when either source knows a release worth showing:
  // the pressed-check verdict (only reasons that carry release facts) or the
  // boot badge verdict (only fires on a confirmed newer release).
  let release: ReleaseView | null = null;
  if (verdict && (verdict.reason === "update-available" || verdict.reason === "no-asset-for-platform" || verdict.reason === "unsupported-install")) {
    // "update-available" is the only reason whose install button may run;
    // "no-asset-for-platform" and friends point at the release page instead.
    release = {
      latestTag: verdict.latestTag,
      latestVersion: verdict.latestVersion,
      releaseUrl: verdict.releaseUrl,
      releaseNotes: cleanReleaseNotes(verdict.releaseNotes),
      canSelfUpdate: verdict.reason === "update-available" && verdict.canSelfUpdate,
    };
  } else if (bootUpdate.hasUpdate) {
    release = {
      latestTag: bootUpdate.latestTag,
      latestVersion: bootUpdate.latestVersion,
      releaseUrl: bootUpdate.releaseUrl,
      releaseNotes: bootUpdate.releaseNotes,
      canSelfUpdate: runtimeInfo?.canSelfUpdate ?? false,
    };
  }

  const checkButton = (label: string, busy = false) => (
    <button
      type="button"
      disabled={busy}
      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-60"
      onClick={() => void runCheck()}
    >
      <Icons.regen />
      {label}
    </button>
  );

  return (
    <>
      {flow.state.kind === "running" && (
        <RunningView
          phaseLabel={t(PHASE_I18N_KEYS[flow.state.phase])}
          progress={flow.state.progress}
        />
      )}

      {flow.state.kind === "complete" && (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-dim text-success-text">
            <Icons.check />
          </span>
          <p className="text-[var(--ui-fs)] font-medium text-t1">
            {t("update_modal_complete", { version: flow.state.newVersion })}
          </p>
          <p className="max-w-[420px] text-[calc(var(--ui-fs)-2px)] text-t3">
            {t("update_modal_restart_instructions")}
          </p>
        </div>
      )}

      {flow.state.kind === "error" && (
        <>
          <ErrorView
            failureKind={flow.state.failureKind}
            message={flow.state.message}
            stack={flow.state.stack}
            raw={flow.state.raw}
            releaseUrl={release?.releaseUrl ?? ""}
            labels={{
              titleSoft: t("update_modal_error_soft_title"),
              titleFatal: t("update_modal_error_fatal_title"),
              details: t("update_modal_error_details"),
              redownload: t("update_modal_redownload"),
            }}
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s2 hover:text-t1"
              onClick={() => void flow.reset()}
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
          </div>
        </>
      )}

      {flow.state.kind === "idle" && (release ? (
        <>
          <p className="mb-3 flex items-center gap-2 text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-dim text-accent-t"><Icons.arrowUpCircle /></span>
            {release.latestTag ? t("update_modal_release_header", { tag: release.latestTag }) : t("update_modal_new_version_available")}
          </p>
          {release.releaseNotes
            ? (
              <div className="md-content-plain max-h-[40vh] overflow-y-auto break-words rounded-md border border-border2 p-3.5 text-[calc(var(--ui-fs)-1px)] leading-relaxed text-t2">
                <Markdown text={release.releaseNotes} variant="plain" />
              </div>
            )
            : <p className="text-[calc(var(--ui-fs)-1px)] text-t2">{t("update_modal_no_notes")}</p>}
          {!release.canSelfUpdate && (
            <p className="mt-3 rounded-md bg-s2 px-3 py-2 text-[calc(var(--ui-fs)-2px)] text-t3">
              {t("update_modal_self_update_unavailable")}
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            {release.canSelfUpdate ? (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-[filter] hover:brightness-110"
                onClick={() => void flow.start()}
              >
                <Icons.download />
                {t("update_modal_update_button")}
              </button>
            ) : release.releaseUrl ? (
              <GitHubFallbackButton releaseUrl={release.releaseUrl} />
            ) : null}
          </div>
        </>
      ) : check.kind === "checking" ? (
        checkButton(t("settings_about_checking"), true)
      ) : check.kind === "failed" ? (
        <div className="space-y-3">
          <p className="text-[calc(var(--ui-fs)-2px)] text-t3">{t("settings_about_check_failed")}</p>
          {checkButton(t("settings_about_check_updates"))}
        </div>
      ) : verdict?.reason === "up-to-date" ? (
        <p className="text-[calc(var(--ui-fs)-2px)] text-t3">{t("settings_about_up_to_date")}</p>
      ) : verdict?.reason === "offline" ? (
        <div className="space-y-3">
          <p className="text-[calc(var(--ui-fs)-2px)] text-t3">{t("settings_about_check_failed")}</p>
          {checkButton(t("settings_about_check_updates"))}
        </div>
      ) : (
        checkButton(t("settings_about_check_updates"))
      ))}
    </>
  );
}
