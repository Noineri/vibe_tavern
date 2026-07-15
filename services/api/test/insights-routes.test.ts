import { describe, expect, it } from "bun:test";
import { createInsightsRoutes } from "../src/api/routes/insights.js";
import type { InsightsRuntimeApi } from "../src/api/contract/runtime-api.js";
import { defaultObjectiveState } from "../src/domain/insights/objective-service.js";

const SCENE_TARGET = { branchId: "branch_1", messageId: "msg_1", variantId: "var_1" };

/** A runtime stub that records every Scene call it receives. */
function sceneRuntime(capture: { method: string; chatId?: string; body?: unknown; signal?: AbortSignal }[]) {
	return {
		refreshInsightsCompletion: async () => ({ target: { chatId: "chat_1", ...SCENE_TARGET }, patch: { objectiveState: defaultObjectiveState() } }),
		generateScene: async (chatId: string, body: unknown, signal?: AbortSignal) => {
			capture.push({ method: "generateScene", chatId, body, signal });
			return { target: { chatId, ...SCENE_TARGET }, message: { id: "msg_1" } };
		},
		editScene: async (chatId: string, body: unknown) => {
			capture.push({ method: "editScene", chatId, body });
			return { target: { chatId, ...SCENE_TARGET }, message: { id: "msg_1" } };
		},
		deleteScene: async (chatId: string, body: unknown) => {
			capture.push({ method: "deleteScene", chatId, body });
			return { target: { chatId, ...SCENE_TARGET }, message: { id: "msg_1" } };
		},
		cancelScene: (chatId: string, body: unknown) => {
			capture.push({ method: "cancelScene", chatId, body });
			return { target: { chatId, ...SCENE_TARGET }, cancelled: true as const };
		},
		getSceneStatus: async (chatId: string, body: unknown) => {
			capture.push({ method: "getSceneStatus", chatId, body });
			return { target: { chatId, ...SCENE_TARGET }, generating: false, record: null };
		},
		previewScene: async (chatId: string, body: unknown, signal?: AbortSignal) => {
			capture.push({ method: "previewScene", chatId, body, signal });
			return { target: { chatId, ...SCENE_TARGET }, sceneState: { mood: "preview" } };
		},
	} as unknown as InsightsRuntimeApi;
}

describe("Insights completion-refresh route", () => {
  it("forwards the typed chat target and request signal", async () => {
    const target = { branchId: "branch_1", messageId: "msg_1" };
    const responseBody = {
      target: { chatId: "chat_1", ...target },
      patch: { objectiveState: defaultObjectiveState() },
    };
    let received: { chatId: string; body: { target: typeof target }; signal?: AbortSignal } | undefined;
    const runtime = {
      refreshInsightsCompletion: async (chatId: string, body: { target: typeof target }, signal?: AbortSignal) => {
        received = { chatId, body, signal };
        return responseBody;
      },
    } as unknown as InsightsRuntimeApi;
    const app = createInsightsRoutes(runtime);
    const controller = new AbortController();

    const response = await app.request("/api/chats/chat_1/insights/completion-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(received).toEqual({ chatId: "chat_1", body: { target }, signal: controller.signal });
  });

  it("accepts an optional variantId on the completion-refresh target", async () => {
    const target = { branchId: "branch_1", messageId: "msg_1", variantId: "var_1" };
    let receivedBody: unknown;
    const runtime = {
      refreshInsightsCompletion: async (_chatId: string, body: unknown) => { receivedBody = body; return { target: { chatId: "chat_1", ...target }, patch: {} }; },
    } as unknown as InsightsRuntimeApi;
    const app = createInsightsRoutes(runtime);

    const response = await app.request("/api/chats/chat_1/insights/completion-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toEqual({ target });
  });

  it("rejects an empty target before calling the runtime", async () => {
    let calls = 0;
    const runtime = {
      refreshInsightsCompletion: async () => {
        calls += 1;
        throw new Error("runtime must not be called");
      },
    } as unknown as InsightsRuntimeApi;
    const app = createInsightsRoutes(runtime);

    const response = await app.request("/api/chats/chat_1/insights/completion-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { branchId: "", messageId: "" } }),
    });

    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });
});

describe("Insights Scene routes (SCN-9)", () => {
  it("generate forwards the immutable target + request signal to the runtime", async () => {
    const capture: { method: string; chatId?: string; body?: unknown; signal?: AbortSignal }[] = [];
    const app = createInsightsRoutes(sceneRuntime(capture));
    const controller = new AbortController();

    const response = await app.request("/api/chats/chat_1/insights/scene/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SCENE_TARGET }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual({ method: "generateScene", chatId: "chat_1", body: { target: SCENE_TARGET }, signal: controller.signal });
  });

  it("edit forwards the target + sceneState", async () => {
    const capture: { method: string; chatId?: string; body?: unknown }[] = [];
    const app = createInsightsRoutes(sceneRuntime(capture));

    const response = await app.request("/api/chats/chat_1/insights/scene/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SCENE_TARGET, sceneState: { mood: "tense" } }),
    });

    expect(response.status).toBe(200);
    expect(capture[0]).toEqual({ method: "editScene", chatId: "chat_1", body: { target: SCENE_TARGET, sceneState: { mood: "tense" } } });
  });

  it("delete + cancel + status forward the immutable target", async () => {
    const capture: { method: string; chatId?: string; body?: unknown }[] = [];
    const app = createInsightsRoutes(sceneRuntime(capture));

    for (const path of ["delete", "cancel", "status"] as const) {
      const response = await app.request(`/api/chats/chat_1/insights/scene/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: SCENE_TARGET }),
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.target).toEqual({ chatId: "chat_1", ...SCENE_TARGET });
    }
    expect(capture.map((c) => c.method)).toEqual(["deleteScene", "cancelScene", "getSceneStatus"]);
  });

  it("rejects a Scene body missing the variantId before calling the runtime", async () => {
    for (const path of ["generate", "edit", "delete", "cancel", "status"] as const) {
      const capture: { method: string }[] = [];
      const app = createInsightsRoutes(sceneRuntime(capture));
      const body = path === "edit"
        ? { target: { branchId: "branch_1", messageId: "msg_1" }, sceneState: {} }
        : { target: { branchId: "branch_1", messageId: "msg_1" } };
      const response = await app.request(`/api/chats/chat_1/insights/scene/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(capture).toHaveLength(0);
    }
  });

  it("preview forwards the target + draft config + signal, and rejects an invalid config", async () => {
    const capture: { method: string; chatId?: string; body?: unknown; signal?: AbortSignal }[] = [];
    const app = createInsightsRoutes(sceneRuntime(capture));
    const controller = new AbortController();
    const draftConfig = {
      schema: { mood: { $type: "string" } },
      autoMode: "assistant", contextWindow: 6, continuityLastN: 3, injectLastN: 1,
      injectionDepth: 1, promptFormat: "json", useChatModel: true,
      generatePrompt: "", injectPrompt: "", providerProfileId: null, model: null,
      revision: 0, schemaHash: "",
    };

    const response = await app.request("/api/chats/chat_1/insights/scene/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SCENE_TARGET, config: draftConfig }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ target: { chatId: "chat_1", ...SCENE_TARGET }, sceneState: { mood: "preview" } });
    expect(capture[0]).toEqual({ method: "previewScene", chatId: "chat_1", body: { target: SCENE_TARGET, config: expect.objectContaining({ autoMode: "assistant" }) }, signal: controller.signal });

    // An invalid draft config (bad $type) is rejected at the schema boundary.
    const badCapture: { method: string }[] = [];
    const badApp = createInsightsRoutes(sceneRuntime(badCapture));
    const bad = await badApp.request("/api/chats/chat_1/insights/scene/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SCENE_TARGET, config: { ...draftConfig, schema: { mood: { $type: "not-a-real-type" } } } }),
    });
    expect(bad.status).toBe(400);
    expect(badCapture).toHaveLength(0);
  });
});

describe("Insights Scene backfill routes (SCN-14)", () => {
  /** A runtime stub whose backfill methods are individually overridable + recorded. */
  function backfillRuntime(capture: { method: string; chatId?: string; arg?: unknown }[]) {
    const status = { runId: "sbr_1", chatId: "chat_1", mode: "fill-missing", status: "completed", total: 2, processed: 2, current: null, errors: [], summary: { total: 2, succeeded: 2, skipped: 0, failed: 0 }, cancelRequested: false };
    return {
      ...sceneRuntime([]),
      startSceneBackfill: async (chatId: string, mode: string) => {
        capture.push({ method: "startSceneBackfill", chatId, arg: mode });
        return { ...status, status: "running", mode };
      },
      getSceneBackfillStatus: async (chatId: string, runId: string) => {
        capture.push({ method: "getSceneBackfillStatus", chatId, arg: runId });
        return { ...status, runId };
      },
      cancelSceneBackfill: (chatId: string, runId: string) => {
        capture.push({ method: "cancelSceneBackfill", chatId, arg: runId });
        return { runId, cancelled: true as const };
      },
      retrySceneBackfill: async (chatId: string, runId: string) => {
        capture.push({ method: "retrySceneBackfill", chatId, arg: runId });
        return { ...status, runId };
      },
    } as unknown as InsightsRuntimeApi;
  }

  it("start forwards the mode (defaulting to fill-missing) and returns the status", async () => {
    const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
    const app = createInsightsRoutes(backfillRuntime(capture));

    // Explicit rebuild mode.
    const res = await app.request("/api/chats/chat_1/insights/scene/backfill/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "rebuild" }),
    });
    expect(res.status).toBe(200);
    expect(capture[0]).toEqual({ method: "startSceneBackfill", chatId: "chat_1", arg: "rebuild" });

    // Empty body → defaults to fill-missing.
    const capture2: { method: string; arg?: unknown }[] = [];
    const app2 = createInsightsRoutes(backfillRuntime(capture2));
    const res2 = await app2.request("/api/chats/chat_1/insights/scene/backfill/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(200);
    expect(capture2[0]!.arg).toBe("fill-missing");
  });

  it("status / cancel / retry forward the path runId", async () => {
    for (const [path, method] of [["status", "getSceneBackfillStatus"], ["cancel", "cancelSceneBackfill"], ["retry", "retrySceneBackfill"]] as const) {
      const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
      const app = createInsightsRoutes(backfillRuntime(capture));
      const res = await app.request(`/api/chats/chat_1/insights/scene/backfill/sbr_9/${path}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(capture[0]).toEqual({ method, chatId: "chat_1", arg: "sbr_9" });
    }
  });

  it("start rejects an unknown mode at the schema boundary (400, runtime untouched)", async () => {
    const capture: { method: string }[] = [];
    const app = createInsightsRoutes(backfillRuntime(capture));
    const res = await app.request("/api/chats/chat_1/insights/scene/backfill/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "purge-everything" }),
    });
    expect(res.status).toBe(400);
    expect(capture).toHaveLength(0);
  });
});
