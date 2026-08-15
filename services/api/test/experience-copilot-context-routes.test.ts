import { describe, test, expect } from "bun:test";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import type {
  ExperienceCopilotRuntimeApi,
  ExperienceCopilotContextState,
} from "../src/api/contract/runtime-api.js";

/**
 * CM-4 — context meter HTTP routes (GET/PATCH `/context`). Pins the path wiring
 * and the PATCH body validation against a fake runtime (the full adapter→store
 * round-trip is covered by experience-copilot-session-lifecycle.test.ts). The
 * fake runtime implements only the two context methods the tests drive — the
 * route builder's other handlers are closures that are never invoked here.
 */

function makeApp() {
  const calls: { patch: Array<{ threadId: string; body: { autoCompact?: boolean } }> } = { patch: [] };
  const state: ExperienceCopilotContextState = { metrics: null, autoCompact: true };

  const runtime = {
    experienceCopilotGetContext: async (): Promise<ExperienceCopilotContextState> => state,
    experienceCopilotPatchContext: async (
      threadId: string,
      body: { autoCompact?: boolean },
    ): Promise<ExperienceCopilotContextState> => {
      calls.patch.push({ threadId, body });
      if (body.autoCompact !== undefined) state.autoCompact = body.autoCompact;
      return state;
    },
  } as unknown as ExperienceCopilotRuntimeApi;

  return { app: createExperienceCopilotRoutes(runtime), calls, state };
}

describe("GET/PATCH /api/experience-copilot/:threadId/context (CM-4)", () => {
  test("GET returns the runtime's context state", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/api/experience-copilot/thread_1/context");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(state);
  });

  test("PATCH forwards the autoCompact body and returns the updated state", async () => {
    const { app, calls, state } = makeApp();
    const res = await app.request("/api/experience-copilot/thread_1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoCompact: false }),
    });
    expect(res.status).toBe(200);
    expect(calls.patch).toEqual([{ threadId: "thread_1", body: { autoCompact: false } }]);
    expect(await res.json()).toEqual({ ...state, autoCompact: false });
  });

  test("PATCH with a non-boolean autoCompact is rejected with 400", async () => {
    const { app, calls } = makeApp();
    const res = await app.request("/api/experience-copilot/thread_1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoCompact: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(calls.patch).toHaveLength(0); // rejected before reaching the adapter
  });

  test("PATCH with an empty body is a no-op (autoCompact optional)", async () => {
    const { app, calls, state } = makeApp();
    const res = await app.request("/api/experience-copilot/thread_1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(calls.patch).toEqual([{ threadId: "thread_1", body: {} }]);
    expect(await res.json()).toEqual(state);
  });
});
