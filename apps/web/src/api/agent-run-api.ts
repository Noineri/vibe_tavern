/** Kind-neutral lifecycle for the shared agent-thread endpoints. Starting a
 * run remains the host's send transport; observing and stopping never POST it. */
import { apiFetch, getGatewayBaseUrl } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import { streamReplayEndpoint, type StreamOpts } from "./stream.js";

export async function listActiveAgentRuns(signal?: AbortSignal): Promise<unknown[]> {
  const active: unknown = await unwrapRpc(await apiFetch(`${getGatewayBaseUrl()}/api/agent-runs`, { signal }));
  if (!Array.isArray(active)) throw new Error("Invalid agent run list");
  return active;
}

export async function isAgentThreadRunning(threadId: string, signal?: AbortSignal): Promise<boolean> {
  const active = await listActiveAgentRuns(signal);
  return active.some((run: unknown) => typeof run === "object" && run !== null && "threadId" in run && run.threadId === threadId);
}

export function subscribeAgentThreadRun(threadId: string, after: number, opts: StreamOpts) {
  return streamReplayEndpoint(`/api/experience-copilot/${encodeURIComponent(threadId)}/run`, after, opts);
}

export async function stopAgentThreadRun(threadId: string): Promise<{ stopped: boolean }> {
  return unwrapRpc(await apiFetch(`${getGatewayBaseUrl()}/api/experience-copilot/${encodeURIComponent(threadId)}/stop`, { method: "POST" }));
}

export const agentThreadRuns = {
  isRunning: isAgentThreadRunning,
  subscribe: subscribeAgentThreadRun,
  stop: stopAgentThreadRun,
};
