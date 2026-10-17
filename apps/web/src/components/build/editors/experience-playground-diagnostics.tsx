/**
 * The Playground's Developer-diagnostics disclosure — the absorbed stateless
 * tester buttons and results, the send-to-copilot buttons, the live-session
 * diagnostics (definition, realtime loop diagnostics, custom action form, raw
 * state, events, effects, console). Moved verbatim out of
 * `ExperiencePlayground.tsx` (file-size ratchet): presentational only — all
 * state, effects and handlers stay in the panel, which passes values and
 * callbacks as props (setters keep their names so the JSX is unchanged). The
 * panel's read-only invariant holds here too: no store is imported or written.
 */
import type { Dispatch, SetStateAction } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { TextInput } from "../../shared/text-input.js";
import type {
  ExperienceParticipant,
  ExperiencePlaygroundData,
  ExperienceTestDefinition,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../../../api/types.js";
import type { ExperienceRoundCommitClaim } from "../../experience/ExperienceFrame.js";
import type { ExperienceLoopConfig } from "../../../lib/experience-loop-host.js";
import type { LoopDiagSample } from "../../../lib/experience-bridge.js";
import {
  buildPlaygroundDigest,
  buildRealtimeLoopDigest,
  type CopilotDigest,
} from "../../../lib/experience-copilot-digest.js";
import type { PlaygroundErrorView } from "./experience-playground-model.js";
import { CONTROLLER_LABEL_KEY } from "./experience-playground-roster.js";
import {
  blockCls,
  blockLabelCls,
  ConsoleBlock,
  JsonBlock,
  RealtimeLoopDiagSection,
  TestRunResultBlock,
  TestSimulateResultBlock,
} from "./experience-playground-results.js";

interface PlaygroundDiagnosticsProps {
  /** The CURRENT UNSAVED rules buffer (only its emptiness gates the tester buttons). */
  code: string;
  diagnosticsOpen: boolean;
  setDiagnosticsOpen: Dispatch<SetStateAction<boolean>>;
  busy: "start" | "advance" | null;
  testerBusy: "run" | "simulate" | null;
  runExplicitAction: (action: () => void) => void;
  handleDiscover: () => Promise<void>;
  handleSimulate: () => Promise<void>;
  testerResult: ExperienceTestRunData | null;
  testerResultSeed: string;
  simResult: ExperienceTestSimulateData | null;
  simResultSeed: string;
  onSendToCopilot: ((digest: CopilotDigest) => void) | undefined;
  handleSendTesterToCopilot: () => void;
  session: ExperiencePlaygroundData | null;
  definition: ExperienceTestDefinition | null;
  error: PlaygroundErrorView | null;
  realtimeRound: ExperienceLoopConfig | null;
  loopDiag: LoopDiagSample | null;
  roundClaim: ExperienceRoundCommitClaim | null;
  participants: ExperienceParticipant[];
  actionType: string;
  setActionType: Dispatch<SetStateAction<string>>;
  actionParticipantId: string;
  setActionParticipantId: Dispatch<SetStateAction<string>>;
  requestId: string;
  setRequestId: Dispatch<SetStateAction<string>>;
  expectedRevision: string;
  setExpectedRevision: Dispatch<SetStateAction<string>>;
  payloadJson: string;
  setPayloadJson: Dispatch<SetStateAction<string>>;
  handleApplyAction: () => Promise<void>;
}

export function PlaygroundDiagnostics({
  code,
  diagnosticsOpen,
  setDiagnosticsOpen,
  busy,
  testerBusy,
  runExplicitAction,
  handleDiscover,
  handleSimulate,
  testerResult,
  testerResultSeed,
  simResult,
  simResultSeed,
  onSendToCopilot,
  handleSendTesterToCopilot,
  session,
  definition,
  error,
  realtimeRound,
  loopDiag,
  roundClaim,
  participants,
  actionType,
  setActionType,
  actionParticipantId,
  setActionParticipantId,
  requestId,
  setRequestId,
  expectedRevision,
  setExpectedRevision,
  payloadJson,
  setPayloadJson,
  handleApplyAction,
}: PlaygroundDiagnosticsProps) {
  const { t } = useT();

  return (
    <>
          {/* Developer diagnostics — collapsed by default. Raw state, revision,
              request id, expected revision, payload JSON, events, effects, and
              console remain reachable after explicit disclosure. XU-4: also the
              absorbed tester (validate rules / auto-play / single action). */}
          <div className={cn(blockCls, "mt-3 p-3")}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left"
                  onClick={() => setDiagnosticsOpen((v) => !v)}
                >
                  <span className="inline-block text-t3 transition-transform" style={{ transform: diagnosticsOpen ? "rotate(90deg)" : "none" }}>▶</span>
                  <span className={blockLabelCls}>{t("experience_playground_diagnostics")}</span>
                  <CustomTooltip content={t("experience_playground_diagnostics_hint")}>
                    <span className="cursor-help text-[11px] text-t4">ⓘ</span>
                  </CustomTooltip>
                </button>
                {diagnosticsOpen && (
                  <div className="mt-2 space-y-2">
                    {/* XU-4: absorbed tester — validate rules (create-only
                        discover) and auto-play script seats (bounded simulate).
                        Both run against the STATELESS tester and stay available
                        before/without a live session. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="playground-discover"
                        className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null || busy !== null || code.trim() === ""}
                        onClick={() => runExplicitAction(() => { void handleDiscover(); })}
                      >
                        {t("experience_tester_run")}
                      </button>
                      <button
                        type="button"
                        data-testid="playground-simulate"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null || busy !== null || code.trim() === ""}
                        onClick={() => runExplicitAction(() => { void handleSimulate(); })}
                      >
                        {t("experience_tester_simulate")}
                      </button>
                      {testerBusy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
                    </div>

                    {/* Grounding step 7: the seed this result RAN with
                        (captured at request time; "—" = none sent, the
                        server deterministic default) — owner-specified line
                        treatment, top of the result block. */}
                    {testerResult !== null && (
                      <>
                        <p className="text-[12px] text-t3" data-testid="playground-discover-seed">
                          {`${t("experience_playground_diagnostics_seed")}: ${testerResultSeed === "" ? "—" : testerResultSeed}`}
                        </p>
                        <TestRunResultBlock result={testerResult} />
                      </>
                    )}
                    {simResult !== null && (
                      <>
                        <p className="text-[12px] text-t3" data-testid="playground-simulate-seed">
                          {`${t("experience_playground_diagnostics_seed")}: ${simResultSeed === "" ? "—" : simResultSeed}`}
                        </p>
                        <TestSimulateResultBlock result={simResult} />
                      </>
                    )}

                    {/* ER-14 (absorbed): send the latest tester digest (discover
                        result → simulate result) to the copilot. */}
                    {onSendToCopilot !== undefined && (testerResult !== null || simResult !== null) && (
                      <button
                        type="button"
                        data-testid="playground-tester-send-to-copilot"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null}
                        onClick={handleSendTesterToCopilot}
                      >
                        {t("experience_tester_send_to_copilot")}
                      </button>
                    )}

                    {/* Live-session diagnostics (send + definition + info +
                        custom action + raw state) — only while a session is live. */}
                    {session !== null && (
                      <>
                    {/* ER-14: send the live session diagnostics to the copilot
                        thread. Shown only when the shell wires the callback AND
                        a session is live. Lives INSIDE the Developer-diagnostics
                        disclosure per the user's intent. RM-13: a realtime round
                        sends the LOOP digest (the turn-session shape would lie
                        — revision/stopReason belong to the server sim). */}
                    {onSendToCopilot !== undefined && (
                      <button
                        type="button"
                        data-testid="playground-send-to-copilot"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={busy !== null}
                        onClick={() =>
                          onSendToCopilot(
                            realtimeRound !== null
                              ? buildRealtimeLoopDigest({
                                  realtime: { tickMs: realtimeRound.tickMs, seed: realtimeRound.seed },
                                  diag: loopDiag,
                                  claim: roundClaim,
                                  definition,
                                  error,
                                })
                              : buildPlaygroundDigest({ session, definition, error }),
                          )
                        }
                      >
                        {t("experience_playground_send_diagnostics")}
                      </button>
                    )}

                    {definition !== null && (
                      <div>
                        <div className={blockLabelCls}>{t("experience_tester_definition")}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-[12px] text-t1">
                          <span className="font-semibold">{definition.manifest.name}</span>
                          <span className="font-mono text-[11px] text-t3">({definition.manifest.id})</span>
                          <span className="text-[11px] text-t3">· apiVersion {definition.apiVersion}</span>
                          {definition.hasChoose && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">choose ✓</span>}
                          {definition.hasFlavor && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">flavor ✓</span>}
                        </div>
                        <div className="mt-1 font-ui text-[11px] text-t3">
                          {definition.declaredCapabilities.length > 0
                            ? definition.declaredCapabilities.map((c) => c.capability).join(", ")
                            : t("experience_assign_no_capabilities")}
                        </div>
                      </div>
                    )}

                    {/* RM-13: realtime rounds show the LOOP's own diagnostics
                        (the authority lives in the frame); the turn-session
                        vocabulary below would be a frozen lie (revision 0 /
                        awaiting_human / create() snapshot forever). */}
                    {realtimeRound !== null && (
                      <RealtimeLoopDiagSection
                        tickMs={realtimeRound.tickMs}
                        seed={realtimeRound.seed}
                        diag={loopDiag}
                        finished={roundClaim !== null}
                      />
                    )}

                    {realtimeRound === null && (
                    <>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
                      <span>{t("experience_playground_session_label")}: <span className="font-mono text-t2">{session.playgroundSessionId.slice(0, 8)}</span></span>
                      <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{session.revision}</span></span>
                      <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{session.status}</span></span>
                      <span>{t("experience_tester_sim_stop_reason")}: <span className="font-mono text-t2">{session.stopReason}</span></span>
                    </div>

                    {/* Custom action form (type/participant/payload/requestId/expectedRevision).
                        Fields share the 34px field row of the setup form. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <TextInput
                        className="w-40 !h-[34px]"
                        value={actionType}
                        placeholder={t("experience_tester_action_type_placeholder")}
                        onChange={(e) => setActionType(e.target.value)}
                      />
                      <div className="w-44 shrink-0">
                        <DropdownSelect
                          value={actionParticipantId}
                          options={participants.map((p) => ({ id: p.id, label: `${p.label} (${t(CONTROLLER_LABEL_KEY[p.controller])})` }))}
                          searchable={false}
                          placeholder={t("experience_tester_action_participant_default")}
                          defaultOption={t("experience_tester_action_participant_default")}
                          onChange={setActionParticipantId}
                          className="h-[34px]"
                        />
                      </div>
                      <TextInput
                        className="w-32 !h-[34px]"
                        value={requestId}
                        aria-label={t("experience_tester_action_request_id")}
                        onChange={(e) => setRequestId(e.target.value)}
                      />
                      <TextInput
                        className="w-24 !h-[34px]"
                        value={expectedRevision}
                        aria-label={t("experience_tester_action_expected_revision")}
                        onChange={(e) => setExpectedRevision(e.target.value)}
                      />
                      <button
                        type="button"
                        className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                        disabled={busy !== null || actionType.trim() === ""}
                        onClick={() => void handleApplyAction()}
                      >
                        {t("experience_tester_action_apply")}
                      </button>
                    </div>
                    <div>
                      <AutoTextarea
                        mono
                        value={payloadJson}
                        onChange={(e) => setPayloadJson(e.target.value)}
                        placeholder={t("experience_tester_action_payload_label")}
                        minRows={1}
                        maxRows={12}
                        macroAutocomplete={false}
                      />
                    </div>

                    <div>
                      <div className={blockLabelCls}>{t("experience_tester_projection")}</div>
                      <JsonBlock value={session.projection.state} />
                    </div>

                    <div>
                      <div className={blockLabelCls}>{t("experience_tester_final_state")}</div>
                      <JsonBlock value={session.state} />
                    </div>
                    </>
                    )}

                    {session.events.length > 0 && (
                      <div>
                        <div className={blockLabelCls}>{t("experience_tester_events")}</div>
                        <div className="mt-1 space-y-1">
                          {session.events.map((event, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", event.visibility === "public" ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>{event.visibility}</span>
                              <span className="font-mono text-[11px] text-t2">{event.type}</span>
                              {event.detail !== undefined && <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event.detail)}</pre>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {session.effects.length > 0 && (
                      <div>
                        <div className={blockLabelCls}>{t("experience_tester_effects")}</div>
                        <div className="mt-1 space-y-1">
                          {session.effects.map((effect, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="shrink-0 rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning-text">{effect.kind}</span>
                              <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(effect.request)}</pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <ConsoleBlock entries={session.console} label={t("script_test_console")} />
                      </>
                    )}
                  </div>
                )}
              </div>
    </>
  );
}
