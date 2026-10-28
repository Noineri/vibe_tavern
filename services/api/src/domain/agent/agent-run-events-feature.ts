/** BR-1c: global lifecycle SSE and the current run list, over one server registry.
 * Follows quota-feature's subscribe-before-ready contract; writes are serialized
 * and every connection owns its cleanup, never the underlying agent execution. */
import { streamSSE } from "hono/streaming";
import type { AgentRunOwner, AgentRunSummary } from "@vibe-tavern/domain";
import type { FeatureModule } from "../../shared/feature-module.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import type { AgentRunRegistry } from "./agent-run-registry.js";

export function createAgentRunEventsFeature(deps: {
  readonly registry: Pick<AgentRunRegistry<AgentRunOwner>, "active" | "onLifecycle">;
}): FeatureModule {
  let unsubscribe: (() => void) | undefined;
  const connections = new Set<AbortController>();
  return {
    id: "agent-run-events",
    activate({ events, router }) {
      unsubscribe = deps.registry.onLifecycle((notification) => events.emit("agent.run", notification));
      router.get("/api/agent-runs", (c) => {
        const active: AgentRunSummary[] = deps.registry.active().flatMap((run) =>
          run.kind === undefined || run.title === undefined ? []
            : [{ threadId: run.threadId, owner: run.owner, kind: run.kind, title: run.title, startedAt: run.startedAt }]);
        return c.json(active);
      });
      router.get("/api/agent-runs/events", (c) => streamSSE(c, async (stream) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        connections.add(controller);
        stream.onAbort(abort);
        c.req.raw.signal.addEventListener("abort", abort, { once: true });
        if (c.req.raw.signal.aborted || stream.aborted) abort();
        let pending = Promise.resolve();
        const enqueue = (write: () => Promise<unknown>) => {
          pending = pending.then(async () => {
            if (!controller.signal.aborted) await write();
          }).catch((error: unknown) => {
            logSendDebug("agent-runs.events.write.error", { message: error instanceof Error ? error.message : String(error) });
            abort();
          });
          return pending;
        };
        const off = events.on("agent.run", (notification) => {
          void enqueue(() => stream.writeSSE({ event: "agent.run", data: JSON.stringify(notification) }));
        }, { signal: controller.signal });
        // Register FIRST, then enqueue the handshake before yielding to the bus.
        const ready = enqueue(() => stream.writeSSE({ event: "ready", data: "{}" }));
        const heartbeat = setInterval(() => { void enqueue(() => stream.write(": ping\n\n")); }, 15_000);
        try {
          await ready;
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          clearInterval(heartbeat);
          abort();
          off();
          c.req.raw.signal.removeEventListener("abort", abort);
          connections.delete(controller);
        }
      }));
    },
    deactivate() {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const controller of connections) controller.abort();
      connections.clear();
    },
  };
}
