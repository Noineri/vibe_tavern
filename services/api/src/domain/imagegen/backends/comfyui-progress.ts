/**
 * @module imagegen/backends/comfyui-progress
 *
 * The ComfyUI WS live-progress listener (CG-C1) — moved out of
 * comfyui.ts (IG-R3): the run snapshots `progress()` publishes and the
 * best-effort execution-events socket that feeds them (the
 * progress/executing/execution_success TEXT frames; binary latent
 * previews are the documented fast-follow, ignored in v1). The snapshot
 * map is module-level state — ONE instance keyed by endpoint, written
 * by generate() and read by progress() in comfyui.ts's factory, every
 * adapter method call running on a FRESH backend instance.
 */

import type { ImageGenWebSocketLike } from "../imagegen-backend.js";

import { isObjectLike } from "./comfyui-listing.js";

/** One run's live-progress snapshot — what `progress()` publishes. */
interface ComfyRunSnapshot {
  promptId: string;
  progress: number;
  state?: string;
}

/** Run snapshots keyed by ENDPOINT, module-level on purpose: every adapter
 *  method call runs on a FRESH backend instance, so the run's generate()
 *  must leave its state where the next poll's instance can read it (the
 *  a1111 twin gets the same for free from the server's own global
 *  /sdapi/v1/progress). One entry per endpoint, overwritten per run: a
 *  local ComfyUI executes one prompt at a time on the GPU and VT drives one
 *  generation at a time (the PG-2 poll-only-while-our-run contract). */
export const comfyRunSnapshots = new Map<string, ComfyRunSnapshot>();

/** Handle to a run's WS listener. */
interface ComfyProgressListener {
  /** Bind the queue response's prompt id and replay buffered events — the
   *  socket opens BEFORE the prompt is queued, so early events can arrive
   *  pre-bind. */
  bindPromptId(promptId: string): void;
  /** Stop listening and close the socket (idempotent). */
  close(): void;
}

/** http(s) endpoint → ws(s) socket URL with the run's client id. */
function comfyWsUrl(endpoint: string, clientId: string): string {
  const wsBase = endpoint.replace(/^http/, "ws");
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/** Open the run's WS listener. Best-effort by design (the A3 family-ladder
 *  degradation precedent): a socket that fails to open NEVER fails the
 *  generation — the run simply publishes no progress. */
export function openComfyProgressListener(
  endpoint: string,
  clientId: string,
  openWebSocket: (url: string) => ImageGenWebSocketLike,
  onJobStarted?: () => void,
): ComfyProgressListener {
  let promptId: string | undefined;
  const buffer: string[] = [];
  let dead = false;
  // MR-11: the first step event attributed to THIS run's prompt_id flips
  // the phase registry to "steps" — exactly once, no matter how many
  // buffered events replay at bind time.
  let jobAnnounced = false;

  const applyEvent = (payload: unknown): void => {
    if (dead || !isObjectLike(payload)) return;
    const data = payload.data;
    const dataRecord = isObjectLike(data) ? data : undefined;
    // ComfyUI broadcasts execution events to EVERY connected socket — only
    // this run's prompt_id counts (the cross-prompt filter).
    if (promptId === undefined || dataRecord === undefined || dataRecord.prompt_id !== promptId) return;
    if (payload.type === "progress") {
      const value = typeof dataRecord.value === "number" && Number.isFinite(dataRecord.value) ? dataRecord.value : 0;
      const max = typeof dataRecord.max === "number" && dataRecord.max > 0 ? dataRecord.max : 0;
      if (max > 0) {
        const fraction = Math.min(Math.max(value / max, 0), 1);
        comfyRunSnapshots.set(endpoint, { promptId, progress: fraction, state: `step ${value}/${max}` });
        if (!jobAnnounced) {
          jobAnnounced = true;
          onJobStarted?.();
        }
      }
      return;
    }
    // `executing` with node === null and `execution_success` both mean the
    // prompt finished executing — the bar's 100%. (execution_error is left
    // alone: the failure surfaces through generate()'s own history
    // classification; the snapshot is informational.)
    if ((payload.type === "executing" && dataRecord.node === null) || payload.type === "execution_success") {
      comfyRunSnapshots.set(endpoint, { promptId, progress: 1 });
    }
  };

  const ingest = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // a malformed frame never breaks the run's progress feed
    }
    applyEvent(parsed);
  };

  let socket: ImageGenWebSocketLike;
  try {
    socket = openWebSocket(comfyWsUrl(endpoint, clientId));
  } catch {
    // Unopenable socket → a dead listener; the run degrades silently.
    return { bindPromptId() {}, close() {} };
  }
  socket.onmessage = (event) => {
    // Binary frames are live latent previews — ignored in v1 (documented
    // fast-follow; the step events are TEXT frames).
    if (dead || typeof event.data !== "string") return;
    if (promptId === undefined) {
      buffer.push(event.data);
      return;
    }
    ingest(event.data);
  };
  socket.onclose = () => {
    dead = true;
  };
  socket.onerror = () => {
    dead = true;
  };

  return {
    bindPromptId(id: string): void {
      if (dead || promptId !== undefined) return;
      promptId = id;
      for (const raw of buffer.splice(0)) ingest(raw);
    },
    close(): void {
      if (dead) return;
      dead = true;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // The socket is already gone — nothing to release.
      }
    },
  };
}
