import { Hono } from "hono";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import * as schemas from "@vibe-tavern/api-contracts";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";

type CopilotStreamEvent = { event: string; data: string };

type RouteAbortBridge = {
  signal: AbortSignal;
  abort: (source: string) => void;
  cleanup: () => void;
};

function createRouteAbortBridge(
  requestSignal: AbortSignal,
  label: string,
  meta: Record<string, unknown>,
): RouteAbortBridge {
  const controller = new AbortController();
  const abort = (source: string) => {
    if (controller.signal.aborted) return;
    logSendDebug(`${label}.abort`, { ...meta, source });
    controller.abort(new DOMException("Client closed copilot stream", "AbortError"));
  };
  const onRequestAbort = () => abort("request");

  if (requestSignal.aborted) {
    abort("request-preaborted");
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort,
    cleanup: () => requestSignal.removeEventListener("abort", onRequestAbort),
  };
}

type SseStreamWriter = {
  aborted: boolean;
  onAbort: (callback: () => void) => void;
  writeSSE: (options: CopilotStreamEvent) => Promise<void>;
};

/** Drain the copilot stream's `{event, data}` iterable into SSE, mirroring the
 *  chat stream route's `writeChatSseEvents`. On a mid-stream provider error the
 *  streaming headers are already sent, so the error surfaces as an SSE `error`
 *  event (not an HTTP status) — same as the chat stream. */
async function writeCopilotSseEvents(
  stream: SseStreamWriter,
  events: AsyncIterable<CopilotStreamEvent>,
  abortBridge: RouteAbortBridge,
): Promise<void> {
  stream.onAbort(() => abortBridge.abort("sse"));
  try {
    for await (const event of events) {
      if (stream.aborted) {
        abortBridge.abort("sse-aborted-flag");
        break;
      }
      await stream.writeSSE({ event: event.event, data: event.data });
    }
  } catch (err) {
    if (abortBridge.signal.aborted || stream.aborted) {
      abortBridge.abort("sse-write-error");
      return;
    }
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    logSendDebug("api.route.copilot-sse.error", { message, category });
    try {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message, category }) });
    } catch {
      abortBridge.abort("sse-error-write-failed");
    }
  } finally {
    abortBridge.cleanup();
  }
}

export function createExperienceCopilotRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .post(
      "/api/experience-copilot/:threadId/stream",
      zValidator("json", schemas.experienceCopilotStreamRequestSchema),
      (c) => {
        const threadId = c.req.param("threadId");
        const body = c.req.valid("json");
        logSendDebug("api.route.experience-copilot-stream.post", { threadId, contentLength: body.content?.length ?? 0 });
        const abortBridge = createRouteAbortBridge(c.req.raw.signal, "api.route.experience-copilot-stream", { threadId });
        const gen = runtime.experienceCopilotStream(threadId, body, abortBridge.signal);
        return streamSSE(c, async (stream) => writeCopilotSseEvents(stream, gen, abortBridge));
      },
    )
    .get("/api/experience-copilot/script/:scriptId/active", async (c) => {
      const scriptId = c.req.param("scriptId");
      return c.json(await runtime.experienceCopilotGetActive(scriptId));
    })
    .get("/api/experience-copilot/:threadId/messages", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotListMessages(threadId));
    })
    .post(
      "/api/experience-copilot/script/:scriptId/session",
      zValidator("json", z.object({ title: z.string().optional() }).optional()),
      async (c) => {
        const scriptId = c.req.param("scriptId");
        const body = c.req.valid("json");
        return c.json(await runtime.experienceCopilotStartNewSession(scriptId, body?.title));
      },
    )
    .get("/api/experience-copilot/script/:scriptId/sessions", async (c) => {
      const scriptId = c.req.param("scriptId");
      return c.json(await runtime.experienceCopilotListSessions(scriptId));
    })
    .post("/api/experience-copilot/:threadId/activate", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotActivate(threadId));
    })
    .post("/api/experience-copilot/:threadId/archive", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotArchive(threadId));
    });
}
