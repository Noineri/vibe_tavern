import { useCallback, useEffect, useState } from "react";
import { agentPlanSchema, type AgentPlan } from "@vibe-tavern/api-contracts";
import { EMPTY_AGENT_PLAN, type AgentPlanOwner } from "@vibe-tavern/domain";
import { getAgentPlan, updateAgentPlan } from "../api/agent-plan-api.js";

interface AgentPlanToolResult {
  ok: true;
  activeTitle?: string;
  remaining?: number;
}

export interface AgentPlanToolCall {
  args: unknown;
  output: unknown;
}

interface AgentPlanCacheEntry {
  plan: AgentPlan;
  isLoading: boolean;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  listeners: Set<() => void>;
}

const cacheByOwner = new Map<string, AgentPlanCacheEntry>();

function ownerKey(owner: AgentPlanOwner): string {
  return `${owner.kind}:${owner.scriptId}`;
}

function entryFor(owner: AgentPlanOwner): AgentPlanCacheEntry {
  const key = ownerKey(owner);
  let entry = cacheByOwner.get(key);
  if (!entry) {
    entry = {
      plan: EMPTY_AGENT_PLAN,
      isLoading: false,
      loaded: false,
      loadPromise: null,
      listeners: new Set(),
    };
    cacheByOwner.set(key, entry);
  }
  return entry;
}

function notify(entry: AgentPlanCacheEntry): void {
  for (const listener of entry.listeners) listener();
}

function replacePlan(entry: AgentPlanCacheEntry, plan: AgentPlan): void {
  entry.plan = plan;
  notify(entry);
}

function loadPlan(owner: AgentPlanOwner, entry: AgentPlanCacheEntry): void {
  if (entry.loaded || entry.loadPromise) return;
  entry.isLoading = true;
  notify(entry);
  entry.loadPromise = getAgentPlan(owner.scriptId)
    .then((plan) => replacePlan(entry, plan))
    .catch((error: unknown) => {
      // A failed GET (server down, transient 5xx) must not become an unhandled
      // rejection fired into whatever test/DOM context mounted the hook. The
      // entry keeps the empty plan and stops loading (one attempt per owner
      // per process — no retry storm); the panel stays hidden and the editor
      // modal surfaces its own save errors. Logged for diagnosability,
      // mirroring the db store's defensive-parse logging.
      console.error(`[use-agent-plan] failed to load the plan for script '${owner.scriptId}':`, error);
    })
    .finally(() => {
      entry.loaded = true;
      entry.isLoading = false;
      entry.loadPromise = null;
      notify(entry);
    });
}

/** Parse the complete plan sent as a streamed `plan` tool-call argument. */
export function parseAgentPlanToolArgs(args: unknown): AgentPlan | null {
  if (typeof args !== "object" || args === null) return null;
  const parsed = agentPlanSchema.safeParse((args as Record<string, unknown>).plan);
  return parsed.success ? parsed.data : null;
}

/** Parse a successful `plan` tool-result envelope. */
export function parseAgentPlanToolResult(output: unknown): AgentPlanToolResult | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  if (record.ok !== true) return null;
  if (record.activeTitle !== undefined && typeof record.activeTitle !== "string") return null;
  if (record.remaining !== undefined && (typeof record.remaining !== "number" || !Number.isInteger(record.remaining) || record.remaining < 0)) return null;
  return {
    ok: true,
    ...(typeof record.activeTitle === "string" ? { activeTitle: record.activeTitle } : {}),
    ...(typeof record.remaining === "number" ? { remaining: record.remaining } : {}),
  };
}

/**
 * Script-owned agent-plan cache. The first consumer of an owner starts its GET;
 * further consumers subscribe to that owner entry, and never share it with a
 * different script.
 */
export function useAgentPlan(owner: AgentPlanOwner): {
  plan: AgentPlan;
  isLoading: boolean;
  save(plan: AgentPlan): Promise<AgentPlan>;
  applyToolResult(toolCall: AgentPlanToolCall): void;
  applyToolResult(args: unknown, output: unknown): void;
} {
  const key = ownerKey(owner);
  const [, setVersion] = useState(0);
  const entry = entryFor(owner);

  useEffect(() => {
    const current = entryFor(owner);
    const listener = () => setVersion((version) => version + 1);
    current.listeners.add(listener);
    loadPlan(owner, current);
    return () => { current.listeners.delete(listener); };
  }, [key, owner]);

  const save = useCallback(async (plan: AgentPlan): Promise<AgentPlan> => {
    const saved = await updateAgentPlan(owner.scriptId, plan);
    replacePlan(entryFor(owner), saved);
    return saved;
  }, [key, owner]);

  const applyToolResult = useCallback((toolCallOrArgs: AgentPlanToolCall | unknown, resultOutput?: unknown): void => {
    const toolCall = resultOutput === undefined
      && typeof toolCallOrArgs === "object"
      && toolCallOrArgs !== null
      && "args" in toolCallOrArgs
      && "output" in toolCallOrArgs
      ? toolCallOrArgs as AgentPlanToolCall
      : { args: toolCallOrArgs, output: resultOutput };
    const plan = parseAgentPlanToolArgs(toolCall.args);
    const result = parseAgentPlanToolResult(toolCall.output);
    if (plan !== null && result !== null) replacePlan(entryFor(owner), plan);
  }, [key, owner]);

  return { plan: entry.plan, isLoading: entry.isLoading, save, applyToolResult };
}
