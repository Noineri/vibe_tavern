import { type ReactNode } from "react";
import type {
  ExperienceSeatLegalityMatrix,
  ExperienceTestConsoleEntry,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../../../api/types.js";
import { cn } from "../../../lib/cn.js";
import type { LoopDiagSample } from "../../../lib/experience-bridge.js";
import { useT } from "../../../i18n/context.js";

// ─── Small render helpers ────────────────────────────────────────────────────

export const blockCls = "rounded-md border border-border bg-bg";
export const blockLabelCls = "text-[11px] font-semibold uppercase tracking-[0.06em] text-t3";

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-t2">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ConsoleBlock({ entries, label }: { entries: readonly ExperienceTestConsoleEntry[]; label: string }) {
  if (entries.length === 0) return null;
  return (
    <div className={cn(blockCls, "mt-2")} style={{ padding: 10 }}>
      <div className={blockLabelCls}>{label}</div>
      <div className="mt-1 space-y-0.5">
        {entries.map((entry, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", entry.level === "error" ? "bg-danger-dim text-danger-text" : entry.level === "warn" ? "bg-s3 text-t2" : "bg-s3 text-t3")}>{entry.level}</span>
            <pre className="flex-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{entry.args.join(" ")}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** RM-13: the realtime loop diagnostics section — the LOOP's own
 *  observability sample replaces the turn-session vocabulary (revision /
 *  stopReason / create() snapshot) which is a frozen lie for realtime rounds.
 *  Everything here comes from the in-frame channel: the latest sampled
 *  projection, the round-log event tail (round_started = the boot signal),
 *  loop errors, and the piped frame console. */
export function RealtimeLoopDiagSection(props: {
  readonly tickMs: number;
  readonly seed: number;
  readonly diag: LoopDiagSample | null;
  readonly finished: boolean;
}): ReactNode {
  const { tickMs, seed, diag, finished } = props;
  const { t } = useT();
  const booted = diag !== null;
  const statusLabel = !booted
    ? t("experience_playground_rt_not_booted")
    : finished || diag.final
      ? t("experience_playground_rt_finished")
      : t("experience_playground_rt_running");
  return (
    <div className={blockCls} style={{ padding: 10 }} data-testid="playground-realtime-diag">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={blockLabelCls}>{t("experience_playground_rt_diag_title")}</span>
        <span className="rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-accent-t">realtime · tick {tickMs}ms · seed {seed}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-ui text-[10px]",
            !booted ? "bg-danger-dim text-danger-text" : finished || diag.final ? "bg-s3 text-t3" : "bg-success-dim text-success-text",
          )}
          data-testid="playground-realtime-diag-status"
        >
          {statusLabel}
        </span>
      </div>
      {!booted ? (
        <p className="mt-1.5 font-ui text-[11px] italic text-t3">{t("experience_playground_rt_not_booted_hint")}</p>
      ) : (
        <div className="mt-2 space-y-2">
          <div>
            <div className={blockLabelCls}>{t("experience_playground_rt_live_view")}</div>
            {diag.view !== undefined ? (
              <JsonBlock value={diag.view} />
            ) : (
              <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_playground_rt_no_view")}</p>
            )}
          </div>
          <div>
            <div className={blockLabelCls}>{t("experience_playground_rt_events")}</div>
            {diag.events.length === 0 ? (
              <p className="mt-1 font-ui text-[11px] italic text-t3">—</p>
            ) : (
              <div className="mt-1 space-y-0.5">
                {diag.events.map((event, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="shrink-0 rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">
                      {typeof event === "object" && event !== null && "kind" in event ? String((event as { kind: unknown }).kind) : "event"}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
          {diag.errors.length > 0 && (
            <div>
              <div className={blockLabelCls}>{t("experience_playground_rt_errors")}</div>
              <div className="mt-1 space-y-0.5">
                {diag.errors.map((err, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="shrink-0 rounded bg-danger-dim px-1.5 py-0.5 font-mono text-[10px] text-danger-text">
                      {typeof err === "object" && err !== null && "kind" in err ? String((err as { kind: unknown }).kind) : "error"}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-danger-text">{JSON.stringify(err)}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
          {diag.console.length > 0 && (
            <div>
              <div className={blockLabelCls}>{t("experience_playground_rt_console")}</div>
              <div className="mt-1 space-y-0.5">
                {diag.console.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
                        entry.level === "error" ? "bg-danger-dim text-danger-text" : entry.level === "warn" ? "bg-s3 text-t2" : "bg-s3 text-t3",
                      )}
                    >
                      {entry.level}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{entry.text}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The per-seat legality matrix (EXPERIENCE_TURN_LEGALITY_DIAGNOSTICS_REPORT
 *  step 3): one compact row per roster seat — its legal action types (or the
 *  actions() error) — with the current turn owners highlighted. Absorbed from
 *  the retired InteractiveTester (XU-4); renders only when the run carried a
 *  roster AND the server supplied the matrix (older builds omit it). */
function SeatLegalityBlock({ matrix, completed }: { matrix: ExperienceSeatLegalityMatrix; completed: boolean }) {
  const { t } = useT();
  if (matrix.seats.length === 0) return null;
  return (
    <div className={blockCls} style={{ padding: 10 }}>
      <div className={blockLabelCls}>{t("experience_tester_seat_legality")}</div>
      <div className="mt-1 space-y-1">
        {matrix.seats.map((seat) => {
          const owner = matrix.turnOwners.includes(seat.participantId);
          return (
            <div key={seat.participantId} className="flex flex-wrap items-center gap-2">
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", owner ? "bg-accent-dim text-accent-t" : "bg-s3 text-t3")}>
                {seat.label} · {seat.controller}
              </span>
              {seat.error !== undefined ? (
                <span className="font-mono text-[10px] text-danger-text">actions() error: {seat.error}</span>
              ) : seat.actionTypes.length === 0 ? (
                <span className="font-ui text-[11px] italic text-t3">{t("experience_tester_no_actions")}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {seat.actionTypes.map((type) => (
                    <span key={type} className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">{type}</span>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 font-ui text-[11px] text-t3">
        {t("experience_tester_turn")}:{" "}
        <span className="font-mono text-t2">
          {matrix.turnOwners.length > 0 ? matrix.turnOwners.join(", ") : completed ? "— (completed)" : "—"}
        </span>
      </div>
    </div>
  );
}

/** XU-4: the retired InteractiveTester's create-only discover result, rendered
 *  verbatim in information content (definition summary, projection, legal
 *  actions, seat legality, events/effects/steps/console). Reuses this file's
 *  `JsonBlock`/`ConsoleBlock`. */
export function TestRunResultBlock({ result }: { result: ExperienceTestRunData }) {
  const { t } = useT();
  return (
    <div className="mt-2 space-y-2">
      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_definition")}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-[12px] text-t1">
          <span className="font-semibold">{result.definition.manifest.name}</span>
          <span className="font-mono text-[11px] text-t3">({result.definition.manifest.id})</span>
          <span className="text-[11px] text-t3">· apiVersion {result.definition.apiVersion}</span>
          {result.definition.hasChoose && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">choose ✓</span>}
          {result.definition.hasFlavor && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">flavor ✓</span>}
          {result.definition.setup !== undefined && (
            <span className="rounded bg-s3 px-1.5 py-0.5 font-ui text-[10px] text-t2">
              {t("experience_tester_setup_fields")}: {result.definition.setup.fields.length}
            </span>
          )}
        </div>
        <div className="mt-1 font-ui text-[11px] text-t3">
          {result.definition.declaredCapabilities.length > 0
            ? result.definition.declaredCapabilities.map((c) => c.capability).join(", ")
            : t("experience_assign_no_capabilities")}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
        <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{result.revision}</span></span>
        <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{result.status}</span></span>
      </div>

      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_projection")}</div>
        <JsonBlock value={result.projection.state} />
      </div>

      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_final_state")}</div>
        <JsonBlock value={result.finalState} />
      </div>

      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_legal_actions")}</div>
        {result.projection.actions.length === 0 ? (
          <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_tester_no_actions")}</p>
        ) : (
          <div className="mt-1 space-y-1">
            {result.projection.actions.map((action, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-accent-t">{action.type}</span>
                {action.label !== undefined && <span className="font-ui text-[11px] text-t2">{action.label}</span>}
                {action.participantId !== undefined && <span className="font-mono text-[10px] text-t3">@{action.participantId}</span>}
                {action.allowsText === true && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t3">text</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <SeatLegalityBlock matrix={result.seatLegality} completed={result.status === "completed"} />

      {result.events.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_events")}</div>
          <div className="mt-1 space-y-1">
            {result.events.map((event, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", event.visibility === "public" ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>{event.visibility}</span>
                <span className="font-mono text-[11px] text-t2">{event.type}</span>
                {event.detail !== undefined && <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event.detail)}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.effects.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_effects")}</div>
          <div className="mt-1 space-y-1">
            {result.effects.map((effect, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="shrink-0 rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning-text">{effect.kind}</span>
                <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(effect.request)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.steps.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_steps")}</div>
          <div className="mt-1 space-y-1">
            {result.steps.map((step, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-t2">
                <span className="text-t3">{step.requestId}</span>
                <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10px] text-accent-t">{step.actionType}</span>
                <span>→ rev {step.revision} · {step.status}</span>
                {step.replayed && <span className="rounded bg-warning-dim px-1.5 py-0.5 text-[10px] uppercase text-warning-text">{t("experience_tester_replayed")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConsoleBlock entries={result.console} label={t("script_test_console")} />
    </div>
  );
}

/** XU-4: the retired InteractiveTester's bounded-simulation result. The typed
 *  stop reason + bounds summary, followed by the accumulated events/effects/
 *  steps/console (the simulate envelope carries them all). */
export function TestSimulateResultBlock({ result }: { result: ExperienceTestSimulateData }) {
  const { t } = useT();
  return (
    <div className="mt-2 space-y-2">
      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_simulate")}</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
          <span>{t("experience_tester_sim_stop_reason")}: <span className="font-mono text-t2">{result.stopReason}</span></span>
          <span>{t("experience_tester_sim_iterations")}: <span className="font-mono text-t2">{result.iterations}</span></span>
          <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{result.revision}</span></span>
          <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{result.status}</span></span>
        </div>
      </div>

      {result.events.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_events")}</div>
          <div className="mt-1 space-y-1">
            {result.events.map((event, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", event.visibility === "public" ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>{event.visibility}</span>
                <span className="font-mono text-[11px] text-t2">{event.type}</span>
                {event.detail !== undefined && <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event.detail)}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.effects.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_effects")}</div>
          <div className="mt-1 space-y-1">
            {result.effects.map((effect, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="shrink-0 rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning-text">{effect.kind}</span>
                <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(effect.request)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.steps.length > 0 && (
        <div className={blockCls} style={{ padding: 10 }}>
          <div className={blockLabelCls}>{t("experience_tester_steps")}</div>
          <div className="mt-1 space-y-1">
            {result.steps.map((step, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-t2">
                <span className="text-t3">{step.requestId}</span>
                <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10px] text-accent-t">{step.actionType}</span>
                <span>→ rev {step.revision} · {step.status}</span>
                {step.replayed && <span className="rounded bg-warning-dim px-1.5 py-0.5 text-[10px] uppercase text-warning-text">{t("experience_tester_replayed")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConsoleBlock entries={result.console} label={t("script_test_console")} />
    </div>
  );
}
