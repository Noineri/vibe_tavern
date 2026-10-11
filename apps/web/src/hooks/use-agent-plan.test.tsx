import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();

const { act, renderHook, waitFor } = await import("@testing-library/react");
const { parseAgentPlanToolArgs, parseAgentPlanToolResult, useAgentPlan } = await import("./use-agent-plan.js");

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string }> = [];

const PLAN: AgentPlan = {
  goal: "Ship the editor",
  constraints: ["Keep it focused"],
  tasks: [{ id: "task_1", title: "Build panel", body: "Use shared fields", status: "active" }],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  const fetchRouter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://gateway.test").toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "GET") return response({ plan: { ...PLAN, goal: url.includes("owner-b") ? "Owner B" : PLAN.goal } });
    return response({ plan: PLAN });
  };
  globalThis.fetch = fetchRouter as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("useAgentPlan", () => {
  it("parses only a complete plan call and successful result envelope", () => {
    expect(parseAgentPlanToolArgs({ plan: PLAN })).toEqual(PLAN);
    expect(parseAgentPlanToolArgs({ plan: { goal: "missing fields" } })).toBeNull();
    expect(parseAgentPlanToolResult({ ok: true, activeTitle: "Build panel", remaining: 1 })).toEqual({ ok: true, activeTitle: "Build panel", remaining: 1 });
    expect(parseAgentPlanToolResult({ ok: false, error: "save failed" })).toBeNull();
  });

  it("starts one lazy GET per owner and never mixes owners", async () => {
    const ownerA = { kind: "script" as const, scriptId: "lazy-owner-a" };
    const ownerB = { kind: "script" as const, scriptId: "lazy-owner-b" };
    const first = renderHook(() => useAgentPlan(ownerA));

    expect(calls).toHaveLength(1);
    await waitFor(() => expect(first.result.current.plan.goal).toBe("Ship the editor"));
    first.rerender();
    expect(calls).toHaveLength(1);

    const second = renderHook(() => useAgentPlan(ownerB));
    await waitFor(() => expect(second.result.current.plan.goal).toBe("Owner B"));
    expect(calls).toHaveLength(2);
    expect(first.result.current.plan.goal).toBe("Ship the editor");
  });

  it("replaces the owner cache only after a successful plan tool result", async () => {
    const owner = { kind: "script" as const, scriptId: "tool-result-owner" };
    const { result } = renderHook(() => useAgentPlan(owner));
    await waitFor(() => expect(result.current.plan.goal).toBe("Ship the editor"));

    const replacement: AgentPlan = { ...PLAN, goal: "Use the streamed plan", tasks: [{ ...PLAN.tasks[0]!, title: "Replace cache" }] };
    act(() => result.current.applyToolResult({ args: { plan: replacement }, output: { ok: true, activeTitle: "Replace cache", remaining: 1 } }));
    expect(result.current.plan).toEqual(replacement);

    act(() => result.current.applyToolResult({ args: { plan: PLAN }, output: { ok: false, error: "not saved" } }));
    expect(result.current.plan).toEqual(replacement);
  });
});
