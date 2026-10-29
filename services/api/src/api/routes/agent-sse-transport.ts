/** Shared numbered replay/live transport for server-owned agent and chat runs.
 * Cancelling a connection releases its subscription, never its producer. */
import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";

type StreamEvent = { event: string; data: string; seq?: number };
type SubscriberBridge = ReturnType<typeof createRouteAbortBridge>;
type SseStreamWriter = {
  aborted: boolean;
  onAbort: (callback: () => void) => void;
  writeSSE: (options: { event: string; data: string; id?: string }) => Promise<void>;
  write: (message: string) => Promise<unknown>;
};

export function createRouteAbortBridge(requestSignal: AbortSignal, label: string, meta: Record<string, unknown>) {
  const controller = new AbortController();
  const abort = (source: string) => {
    if (controller.signal.aborted) return;
    logSendDebug(`${label}.abort`, { ...meta, source });
    controller.abort(new DOMException("Client closed generation stream", "AbortError"));
  };
  const onRequestAbort = () => abort("request");
  if (requestSignal.aborted) abort("request-preaborted");
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  return { signal: controller.signal, abort, cleanup: () => requestSignal.removeEventListener("abort", onRequestAbort) };
}

/** Keep silent model calls under the server idle timeout with SSE comments.
 * Exactly one next() remains pending across heartbeat ticks; starting another
 * pull would silently consume/discard real events. Errors normally arrive as
 * numbered producer frames; retain the old fallback for raw/test iterables. */
export async function writeAgentSseEvents(
  stream: SseStreamWriter, events: AsyncIterable<StreamEvent>, bridge: SubscriberBridge, heartbeatMs = 15_000,
): Promise<void> {
  stream.onAbort(() => bridge.abort("sse"));
  const iterator = events[Symbol.asyncIterator]();
  let pendingNext: Promise<IteratorResult<StreamEvent, unknown>> | undefined;
  try {
    while (true) {
      if (stream.aborted || bridge.signal.aborted) { bridge.abort("sse-aborted-flag"); break; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        (pendingNext ??= iterator.next()),
        new Promise<"heartbeat">((resolve) => { timer = setTimeout(() => resolve("heartbeat"), heartbeatMs); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (raced === "heartbeat") { await stream.write(": ping\n\n"); continue; }
      pendingNext = undefined;
      if (raced.done) break;
      await stream.writeSSE({ event: raced.value.event, data: raced.value.data,
        ...(raced.value.seq !== undefined ? { id: String(raced.value.seq) } : {}) });
    }
  } catch (error) {
    if (bridge.signal.aborted || stream.aborted) { bridge.abort("sse-write-error"); return; }
    const message = extractProviderErrorMessage(error);
    const category = classifyProviderError(error);
    logSendDebug("api.route.agent-sse.error", { message, category });
    try { await stream.writeSSE({ event: "error", data: JSON.stringify({ message, category }) }); }
    catch { bridge.abort("sse-error-write-failed"); }
  } finally {
    await iterator.return?.();
    bridge.cleanup();
  }
}
