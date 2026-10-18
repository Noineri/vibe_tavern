/**
 * The playground's session-log selector — the realtime-vs-turn choice behind
 * the status-strip "send log" / "copy log" buttons. Extracted from
 * ExperiencePlayground.tsx to keep that file within its arch-gate size budget:
 * a pure function over the component's state, so the selection is testable
 * without React and the component keeps only a thin state-passing wrapper.
 */
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import type {
  ExperiencePlaygroundData,
  ExperienceTestDefinition,
} from "../../../api/types.js";
import type { ExperienceRoundCommitClaim } from "../../experience/ExperienceFrame.js";
import type { ExperienceLoopConfig } from "../../../lib/experience-loop-host.js";
import type { LoopDiagSample } from "../../../lib/experience-bridge.js";
import {
  buildPlaygroundLogDigest,
  buildRealtimeLoopDigest,
  type CopilotLogDigest,
  type PlaygroundSessionLog,
} from "../../../lib/experience-copilot-digest.js";
import type { PlaygroundErrorView } from "./experience-playground-model.js";

/** The component state the session-log selector reads. Field names mirror the
 *  ExperiencePlayground state so the call site stays a straight pass-through. */
export interface SessionLogDigestInput {
  /** The live playground session (the turn-log branch's authority). */
  readonly live: ExperiencePlaygroundData;
  /** The latched realtime round config; non-null selects the loop digest. */
  readonly realtimeRound: ExperienceLoopConfig | null;
  /** The latest loop diagnostics sample (replace semantics). */
  readonly loopDiag: LoopDiagSample | null;
  /** The finalized round claim, once the loop finished. */
  readonly roundClaim: ExperienceRoundCommitClaim | null;
  readonly definition: ExperienceTestDefinition | null;
  readonly error: PlaygroundErrorView | null;
  /** The whole-session turn-log accumulator. */
  readonly sessionLog: PlaygroundSessionLog;
  /** The launch context the session started with (captured at start). */
  readonly logLaunchContext: ExperienceCopilotLaunchContext | null;
}

/** Grounding step 6: the WHOLE-session log digest for the status-strip
 *  "send log" / "copy log" buttons. Turn sessions send the accumulated log
 *  (every event across start + advances + timer beats); a realtime round
 *  sends the loop digest — the frame loop is the round's authority, and the
 *  turn-session shape would lie (RM-13). */
export function buildSessionLogDigest(input: SessionLogDigestInput): CopilotLogDigest {
  const {
    live,
    realtimeRound,
    loopDiag,
    roundClaim,
    definition,
    error,
    sessionLog,
    logLaunchContext,
  } = input;
  return realtimeRound !== null
    ? buildRealtimeLoopDigest({
        realtime: { tickMs: realtimeRound.tickMs, seed: realtimeRound.seed },
        diag: loopDiag,
        claim: roundClaim,
        definition,
        error,
      })
    : buildPlaygroundLogDigest({
        session: live,
        sessionLog,
        definition,
        error,
        launchContext: logLaunchContext,
      });
}
