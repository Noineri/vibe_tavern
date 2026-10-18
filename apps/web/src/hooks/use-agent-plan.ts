import { useCallback, useEffect, useRef, useState } from "react";
import { agentPlanSchema, type AgentPlan } from "@vibe-tavern/api-contracts";
import { EMPTY_AGENT_PLAN, type AgentPlanOwner } from "@vibe-tavern/domain";
import { getAgentPlan, updateAgentPlan } from "../api/agent-plan-api.js";
import { getAgentBranchPlan, updateAgentBranchPlan } from "../api/agent-branch-plan-api.js";

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

/** The per-owner cache key — the two union arms address different routes
 *  (script rows vs branch rows), so their entries never mix. */
function ownerKey(owner: AgentPlanOwner): string {
  return owner.kind === "script"
    ? `script:${owner.scriptId}`
    : `chatBranch:${owner.chatId}:${owner.branchId}`;
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
  const key = ownerKey(owner);
  entry.isLoading = true;
  notify(entry);
  // SC-0i: each union arm reads its own route (script rows vs branch rows) —
  // a branch owner here is routed, never rejected (the SC-0h interim guard
  // is gone: the hook serves both owners).
  const load = owner.kind === "script"
    ? getAgentPlan(owner.scriptId)
    : getAgentBranchPlan(owner.chatId, owner.branchId);
  entry.loadPromise = load
    .then((plan) => replacePlan(entry, plan))
    .catch((error: unknown) => {
      // A failed GET (server down, transient 5xx) must not become an unhandled
      // rejection fired into whatever test/DOM context mounted the hook. The
      // entry keeps the empty plan and stops loading (one attempt per owner
      // per process — no retry storm); the panel stays hidden and the editor
      // modal surfaces its own save errors. Logged for diagnosability,
      // mirroring the db store's defensive-parse logging.
      console.error(`[use-agent-plan] failed to load the plan for '${key}':`, error);
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
 * Agent-plan cache for one owner (SC-0i: the full `AgentPlanOwner` union —
 * script owners read/write the script route, branch owners the branch route).
 * The first consumer of an owner starts its GET; further consumers subscribe
 * to that owner entry, and never share it with a different owner.
 *
 * `undefined` is the host-without-a-plan-block case (the descriptor's
 * `planOwner` is absent — SC-0i): no fetch runs, the plan stays empty, and
 * `applyToolResult` is a no-op (the controller feeds it unconditionally, so
 * it must never crash a turn). `save` without an owner is a programming
 * error caught loudly — the editor UI that calls it is never rendered then.
 */
export function useAgentPlan(owner: AgentPlanOwner | undefined): {
  plan: AgentPlan;
  isLoading: boolean;
  save(plan: AgentPlan): Promise<AgentPlan>;
  applyToolResult(toolCall: AgentPlanToolCall): void;
  applyToolResult(args: unknown, output: unknown): void;
} {
  const key = owner === undefined ? null : ownerKey(owner);
  const [, setVersion] = useState(0);
  // The KEY carries the identity (effect deps), the ref carries the value
  // (call args) — the shell passes a fresh-but-equal owner literal on every
  // render, and depending on the object would resubscribe every time (the
  // same KEY/ref split the shell's session effects use). The `key` read
  // below keeps the dep honest: the effect only proceeds for the live owner.
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const entry = owner === undefined ? null : entryFor(owner);

  useEffect(() => {
    const currentOwner = ownerRef.current;
    if (currentOwner === undefined || ownerKey(currentOwner) !== key) return;
    const current = entryFor(currentOwner);
    const listener = () => setVersion((version) => version + 1);
    current.listeners.add(listener);
    loadPlan(currentOwner, current);
    return () => { current.listeners.delete(listener); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const save = useCallback(async (plan: AgentPlan): Promise<AgentPlan> => {
    const currentOwner = ownerRef.current;
    if (currentOwner === undefined) throw new Error("use-agent-plan: no plan owner (the host defines no plan block)");
    const saved = currentOwner.kind === "script"
      ? await updateAgentPlan(currentOwner.scriptId, plan)
      : await updateAgentBranchPlan(currentOwner.chatId, currentOwner.branchId, plan);
    replacePlan(entryFor(currentOwner), saved);
    return saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const applyToolResult = useCallback((toolCallOrArgs: AgentPlanToolCall | unknown, resultOutput?: unknown): void => {
    const currentOwner = ownerRef.current;
    if (currentOwner === undefined) return;
    const toolCall = resultOutput === undefined
      && typeof toolCallOrArgs === "object"
      && toolCallOrArgs !== null
      && "args" in toolCallOrArgs
      && "output" in toolCallOrArgs
      ? toolCallOrArgs as AgentPlanToolCall
      : { args: toolCallOrArgs, output: resultOutput };
    const plan = parseAgentPlanToolArgs(toolCall.args);
    const result = parseAgentPlanToolResult(toolCall.output);
    if (plan !== null && result !== null) replacePlan(entryFor(currentOwner), plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { plan: entry?.plan ?? EMPTY_AGENT_PLAN, isLoading: entry?.isLoading ?? false, save, applyToolResult };
}
