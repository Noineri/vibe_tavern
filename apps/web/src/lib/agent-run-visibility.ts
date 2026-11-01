import { useEffect } from "react";
import { agentThreadKey } from "./agent-host-registry.js";

// Registrations are view-owned leases: multiple visible views of the same
// thread can coexist, and an old cleanup cannot remove a newer registration.
const visible = new Map<string, Set<symbol>>();
export function registerVisibleAgentThread(kind: string, threadId: string): () => void {
  const key = agentThreadKey(kind, threadId);
  const token = Symbol();
  const viewers = visible.get(key) ?? new Set<symbol>();
  viewers.add(token);
  visible.set(key, viewers);
  return () => {
    viewers.delete(token);
    if (viewers.size === 0 && visible.get(key) === viewers) visible.delete(key);
  };
}

export function isAgentThreadVisible(kind: string, threadId: string): boolean {
  return (visible.get(agentThreadKey(kind, threadId))?.size ?? 0) > 0;
}

export function useVisibleAgentThread(kind: string, threadId: string | null, onScreen: boolean): void {
  useEffect(() => {
    if (threadId !== null && onScreen) return registerVisibleAgentThread(kind, threadId);
  }, [kind, threadId, onScreen]);
}
