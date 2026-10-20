/**
 * @module imagegen/backends/comfyui-history
 *
 * The ComfyUI completion poll — moved out of comfyui.ts (IG-R3): the
 * `/history/{id}` polling loop generate() awaits until terminal state,
 * its poll-outcome classification, the abort-aware poll delay and
 * cadence constant, and the base-URL normalization the config parser
 * shares.
 *
 * Doc gate (every wire fact below live-verified on the owner's ComfyUI
 * 0.36.0 / Stability Matrix instance, 2026-09-18 — probe scripts in
 * reports/IMAGEGEN_POLISH_REPORT.md § PG-5):
 * - completion: `GET /history/{prompt_id}` — the response is a map keyed
 *   by prompt id; an absent key = still queued/running. Terminal success:
 *   `status.completed === true` with `outputs[nodeId].images[]` entries
 *   `{filename, subfolder, type}`. Terminal failure: `status.status_str
 *   === "error"` with the readable reason inside `status.messages[]` as
 *   the `execution_error` pair's `exception_message`.
 *
 * Card-driven deviations from the a1111 twin (named, verified):
 * - NO sync generation POST: ComfyUI queues asynchronously, so the adapter
 *   polls `/history` until terminal. The poll cadence is a named internal
 *   constant (NOT a user-facing generation parameter — the owner's ban
 *   covers generation params; completion detection is transport mechanics,
 *   same class as the cloud timeout budget).
 * - NO local timeout: the run continues until terminal state or the
 *   caller's abort (the localExecution contract; the poll delay is
 *   abortable so cancellation is prompt).
 */

import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

import { fetchOrWrap } from "./backend-helpers.js";
import { ComfyImageGenError } from "./comfyui-errors.js";
import { COMFY_NODE_IDS } from "./comfyui-workflows.js";

/** Normalize a pasted base URL: trailing slashes and a pasted `…/prompt`
 *  generation path are tolerated (the paste-tolerance discipline). */
export function normalizeComfyBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/prompt")) {
    normalized = normalized.slice(0, -"/prompt".length);
  }
  return normalized.replace(/\/+$/, "");
}

/** The completion-poll cadence — transport mechanics, not a generation
 *  parameter (see the module doc gate). */
export const COMFY_HISTORY_POLL_INTERVAL_MS = 250;

/** An abort-aware delay between history polls: the caller's cancel exits
 *  the wait promptly with the raw AbortError (user cancel, not a failure). */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/** The SaveImage node's output-rows container (top-level node outputs ride
 *  the history entry keyed by node id). */
export interface ComfyHistoryOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** One `/history/{id}` poll response classified: pending (keep polling),
 *  done (the SaveImage output rows), or failed (the execution_error
 *  message). */
type ComfyPollOutcome =
  | { kind: "pending" }
  | { kind: "done"; images: ComfyHistoryOutputImage[] }
  | { kind: "failed"; message: string };

/** Extract the readable failure reason from a terminal error entry: the
 *  `status.messages` array of `[type, payload]` pairs carries the
 *  `execution_error` payload with `exception_message` (+ node_type /
 *  node_id for locating it). Anything unreadable degrades to the status
 *  string, never an invented message. */
function classifyHistoryEntry(entry: unknown): ComfyPollOutcome {
  if (typeof entry !== "object" || entry === null) return { kind: "pending" };
  const record = entry as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "object" || status === null) return { kind: "pending" };
  const statusRecord = status as Record<string, unknown>;
  if (statusRecord.status_str === "error") {
    let message = "ComfyUI execution error";
    const messages = statusRecord.messages;
    if (Array.isArray(messages)) {
      for (const pair of messages) {
        if (!Array.isArray(pair) || pair[0] !== "execution_error") continue;
        const payload = pair[1];
        if (typeof payload !== "object" || payload === null) continue;
        const detail = payload as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof detail.node_type === "string" && detail.node_type.length > 0) parts.push(detail.node_type);
        if (typeof detail.exception_message === "string" && detail.exception_message.length > 0) {
          parts.push(detail.exception_message);
        }
        if (parts.length > 0) {
          message = `ComfyUI execution error: ${parts.join(": ")}`;
          break;
        }
      }
    }
    return { kind: "failed", message };
  }
  if (statusRecord.completed !== true) return { kind: "pending" };
  const outputs = record.outputs;
  if (typeof outputs !== "object" || outputs === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the history entry carries no outputs" };
  }
  const nodeOutput = (outputs as Record<string, unknown>)[COMFY_NODE_IDS.saveImage];
  if (typeof nodeOutput !== "object" || nodeOutput === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the SaveImage node produced no output" };
  }
  const images = (nodeOutput as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt with no saved images" };
  }
  const rows: ComfyHistoryOutputImage[] = [];
  for (const image of images) {
    if (typeof image !== "object" || image === null) continue;
    const row = image as Record<string, unknown>;
    if (typeof row.filename !== "string" || row.filename.length === 0) continue;
    rows.push({
      filename: row.filename,
      ...(typeof row.subfolder === "string" && row.subfolder.length > 0 ? { subfolder: row.subfolder } : {}),
      ...(typeof row.type === "string" && row.type.length > 0 ? { type: row.type } : {}),
    });
  }
  if (rows.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the saved-image rows are malformed" };
  }
  return { kind: "done", images: rows };
}

/** Await prompt completion by polling `/history/{id}` until terminal —
 *  abortable, no timeout (the localExecution contract). */
export async function waitForPromptCompletion(
  transport: typeof fetch,
  endpoint: string,
  promptId: string,
  signal: AbortSignal | undefined,
): Promise<ComfyHistoryOutputImage[]> {
  for (;;) {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/history/${encodeURIComponent(promptId)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "history poll",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new ComfyImageGenError(
        `ComfyUI history poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const parsed: unknown = await response.json().catch(() => null);
    const entry = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[promptId]
      : undefined;
    const outcome = classifyHistoryEntry(entry);
    if (outcome.kind === "done") return outcome.images;
    if (outcome.kind === "failed") throw new ComfyImageGenError(outcome.message);
    await abortableDelay(COMFY_HISTORY_POLL_INTERVAL_MS, signal);
  }
}
