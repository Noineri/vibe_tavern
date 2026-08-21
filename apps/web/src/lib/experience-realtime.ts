/**
 * RM-9/RM-10 realtime helpers (REALTIME_EXPERIENCE_MODE_PLAN), shared by the
 * Try-it playground panel AND the live launcher. Lives in `lib/` (moved from
 * `components/build/editors/` in RM-10) because the launcher importing a
 * build-editor module would invert the layer direction — build editors import
 * experience components, never the reverse.
 *
 * Pure/injectable logic lifted out of `ExperiencePlayground.tsx` so the
 * realtime branch is unit-testable without rendering the frame:
 *
 *   - {@link buildRealtimeLoopConfig} assembles the frame loop's
 *     `ExperienceLoopConfig` from launch inputs (rules source, manifest
 *     tickMs, the session's state + numeric seed, and the roster). The config
 *     is LATCHED once per round — an unstable config would rebuild the frame
 *     document and restart the loop.
 *   - {@link createPlaygroundModelSeam} mirrors the RM-6 modal model-seam
 *     contract exactly: resolve to the model's reply data (the component posts
 *     it back via `sendModelResult`), or `null` to send NOTHING into the
 *     frame. Fail-closed in both directions: an unpinned/unknown seat or a
 *     failed endpoint never lets raw error text reach the visual.
 *
 * The server remains the authority for `create` (Try-it still calls
 * `startExperiencePlayground`, the live flow starts the durable session —
 * author code never executes host-side); these helpers only shape data the
 * frame consumes.
 */
import type { ExperienceController, ExperienceViewer } from "@vibe-tavern/domain";
import type { runExperienceRoundModel } from "../api/experience-api.js";
import type { ExperienceModelSeatRequest } from "../components/experience/ExperienceFrame.js";
import type { ExperienceLoopConfig } from "./experience-loop-host.js";

/** The roster slice the realtime config needs (mirrors the panel's seat row). */
export interface PlaygroundRealtimeSeat {
  readonly id: string;
  readonly label: string;
  readonly controller: ExperienceController;
  /** Pinned provider profile for a model seat (IR-90E); required by the seam. */
  readonly providerProfileId?: string;
  /** Pinned model id for a model seat (IR-90E); required by the seam. */
  readonly modelId?: string;
}

export interface BuildRealtimeLoopConfigInput {
  /** The author's rules source — the panel's CURRENT buffer (what start sent). */
  readonly rulesSource: string;
  /** The discovered manifest tickMs. Undefined ⇒ the package is not a valid
   *  realtime definition (contracts reject it at authoring — this is the
   *  typed guard for a stale/odd discovery payload). */
  readonly tickMs: number | undefined;
  /** The server-started session's post-create state (revision 0). */
  readonly initialState: unknown;
  /** The settings object the start call just sent (echoed into round_started). */
  readonly initialSettings: unknown;
  /** The resolved numeric seed echoed by the playground start response. */
  readonly seed: number;
  /** The roster (empty-id rows are dropped, exactly like the server request). */
  readonly seats: readonly PlaygroundRealtimeSeat[];
  /** The chosen human seat id ("" = unset ⇒ first human seat; none ⇒ observer). */
  readonly humanSeatId: string;
}

export type BuildRealtimeLoopConfigResult =
  | { readonly ok: true; readonly config: ExperienceLoopConfig }
  | { readonly ok: false; readonly message: string };

/**
 * Assemble the frame loop config for a realtime Try-it round. The capability
 * surface is UNGATED here by design: the frame loop injects `participants` +
 * the round cursor itself, and the RM-8 server replay mirrors exactly this
 * surface — grant gating lives only in the server's create, which the
 * playground start already ran.
 */
export function buildRealtimeLoopConfig(
  input: BuildRealtimeLoopConfigInput,
): BuildRealtimeLoopConfigResult {
  if (input.rulesSource.trim() === "") {
    return { ok: false, message: "Realtime round cannot start: the rules source is empty." };
  }
  if (input.tickMs === undefined || !Number.isInteger(input.tickMs) || input.tickMs <= 0) {
    return {
      ok: false,
      message:
        "Realtime round cannot start: the discovered manifest has no valid tickMs (realtime mode requires it).",
    };
  }
  if (!Number.isInteger(input.seed) || input.seed < 0) {
    return { ok: false, message: "Realtime round cannot start: the resolved round seed is invalid." };
  }

  const seats = input.seats.filter((seat) => seat.id.trim() !== "");
  const humanSeat =
    (input.humanSeatId !== "" ? seats.find((seat) => seat.id === input.humanSeatId) : undefined) ??
    seats.find((seat) => seat.controller === "human");
  const viewer: ExperienceViewer =
    humanSeat !== undefined
      ? { kind: "human", participantId: humanSeat.id }
      : { kind: "observer" };

  const scriptSeats: ExperienceViewer[] = seats
    .filter((seat) => seat.controller === "script")
    .map((seat) => ({ kind: "script", participantId: seat.id }));
  const modelSeats: ExperienceViewer[] = seats
    .filter((seat) => seat.controller === "model")
    .map((seat) => ({ kind: "model", participantId: seat.id }));
  const participants = seats.map((seat) => ({
    id: seat.id,
    label: seat.label.trim() === "" ? seat.id : seat.label,
    controller: seat.controller,
  }));

  return {
    ok: true,
    config: {
      rulesSource: input.rulesSource,
      tickMs: input.tickMs,
      initialState: input.initialState,
      initialSettings: input.initialSettings,
      seed: input.seed,
      viewer,
      scriptSeats,
      ...(modelSeats.length > 0 ? { modelSeats } : {}),
      ...(participants.length > 0 ? { participants } : {}),
    },
  };
}

export interface PlaygroundModelSeamDeps {
  /** The round-model endpoint client (injected so tests never touch the wire). */
  readonly roundModel: typeof runExperienceRoundModel;
  /** Resolve a seat's pinned provider profile + model (IR-90E roster config).
   *  Null ⇒ the seat is unknown or unpinned: fail-closed. */
  readonly seatProfile: (seatId: string) => { providerProfileId: string; modelId: string } | null;
  /** Panel-level diagnostic sink (normalized, visual-safe messages only). */
  readonly onError: (message: string) => void;
}

/**
 * The Try-it model seam (RM-9), mirroring the RM-6 modal contract verbatim:
 * resolve to the reply data (posted into the round via `sendModelResult`) or
 * `null` to leave the round without that reply. NEVER throws and NEVER leaks
 * raw endpoint text — the round log is the source of truth and a missing
 * reply is a legitimate round outcome (the loop simply continues).
 */
export function createPlaygroundModelSeam(
  deps: PlaygroundModelSeamDeps,
): (req: ExperienceModelSeatRequest) => Promise<unknown | null> {
  return async (req) => {
    const profile = deps.seatProfile(req.seatId);
    if (profile === null) {
      deps.onError(`Realtime model seat "${req.seatId}" has no pinned provider/model — request dropped.`);
      return null;
    }
    try {
      const response = await deps.roundModel({
        seatId: req.seatId,
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
        providerProfileId: profile.providerProfileId,
        modelId: profile.modelId,
        prompt: req.prompt,
      });
      return response.result;
    } catch {
      // Fail-closed: the round lives without this reply; raw endpoint text
      // must never reach the visual (RM-6 contract).
      deps.onError(`Realtime model request for seat "${req.seatId}" failed — reply dropped.`);
      return null;
    }
  };
}
