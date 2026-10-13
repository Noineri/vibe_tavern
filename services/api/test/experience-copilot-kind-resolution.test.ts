import { describe, test, expect } from "bun:test";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ScriptRow,
  StoreContainer,
} from "@vibe-tavern/db";
import {
  ExperienceCopilotAdapter,
} from "../src/api/adapters/experience-copilot-adapter.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import {
  NoAgentKindForScriptKindError,
} from "../src/domain/agent/agent-kind-registry.js";
import type {
  ExperienceCopilotRuntimeApi,
} from "../src/api/contract/runtime-api.js";

/**
 * AS-2c — kind resolution at the stream-turn start. The adapter resolves the
 * agent kind for a thread's script row through the registry
 * (`experienceCopilotAssertStreamKind`), and the stream route maps the
 * registry's errors to a 400 JSON response BEFORE any SSE headers are sent.
 *
 * The adapter-level tests execute the REAL seam (thread → script row →
 * `resolveKindForScript`). The route-level tests pin the error MAPPING against
 * a fake runtime that throws exactly what the adapter throws for an unserved
 * script kind — the mapping itself is the unit under pin there. Today the
 * experience kind serves every reachable copilot thread (interactive scripts),
 * so the 400 is a genuinely unreachable production state until a second
 * script kind gains copilot threads; the seam + mapping are pinned ahead of
 * that, per AGENT_SHELL_PLAN AS-2c.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeThread(scriptId: string | null = "script_kr_1"): ExperienceCopilotThread {
  return {
    id: "thread_kr_1",
    scriptId,
    draftSessionId: null,
    title: "Kind resolution",
    archivedAt: null,
    contextMetrics: null,
    contextLinks: [],
    lastProviderProfileId: null,
    lastModel: null,
    autoCompact: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    todo: [],
  };
}

function makeScriptRow(scriptKind: string, id = "script_kr_1"): ScriptRow {
  return {
    id,
    name: "Kind resolution script",
    description: "",
    code: "",
    enabled: true,
    scriptKind,
    origin: "in_app",
    firstEnabledAt: null,
    creationIntentId: null,
    scopeType: "global",
    sortOrder: 0,
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: null,
    copilotProfileId: null,
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ScriptRow;
}

function makeAdapter(thread: ExperienceCopilotThread | null, script: ScriptRow | null) {
  const store = {
    async getById(threadId: string) {
      return thread && thread.id === threadId ? thread : null;
    },
  } as unknown as ExperienceCopilotStore;
  const scripts = {
    async getById(scriptId: string) {
      return script && script.id === scriptId ? script : null;
    },
  };
  const stores = { experienceCopilot: store, scripts } as unknown as StoreContainer;
  return new ExperienceCopilotAdapter(stores);
}

// ─── Adapter-level: the real resolution seam ─────────────────────────────────

describe("ExperienceCopilotAdapter.experienceCopilotAssertStreamKind (AS-2c)", () => {
  test("an interactive script resolves through the registry without throwing", async () => {
    const adapter = makeAdapter(makeThread(), makeScriptRow("interactive"));
    await expect(adapter.experienceCopilotAssertStreamKind("thread_kr_1")).resolves.toBeUndefined();
  });

  test("a script kind no registered kind serves throws NoAgentKindForScriptKindError", async () => {
    const adapter = makeAdapter(makeThread(), makeScriptRow("dice"));
    let caught: unknown;
    try {
      await adapter.experienceCopilotAssertStreamKind("thread_kr_1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoAgentKindForScriptKindError);
    const error = caught as NoAgentKindForScriptKindError;
    expect(error.code).toBe("NO_AGENT_KIND_FOR_SCRIPT_KIND");
    expect(error.scriptKind).toBe("dice");
  });

  test("a draft thread (scriptId null) and a dangling script link resolve nothing", async () => {
    const draftAdapter = makeAdapter(makeThread(null), makeScriptRow("interactive"));
    await expect(draftAdapter.experienceCopilotAssertStreamKind("thread_kr_1")).resolves.toBeUndefined();
    // Dangling soft link: the script row is gone — today's draft semantics.
    const danglingAdapter = makeAdapter(makeThread(), null);
    await expect(danglingAdapter.experienceCopilotAssertStreamKind("thread_kr_1")).resolves.toBeUndefined();
  });

  test("a missing thread throws the stream's 404 (not a kind error)", async () => {
    const adapter = makeAdapter(null, makeScriptRow("interactive"));
    let caught: unknown;
    try {
      await adapter.experienceCopilotAssertStreamKind("thread_missing");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as { kind?: string; message: string };
    expect(error.kind).toBe("NotFound");
    expect(error.message).toContain("thread_missing");
  });
});

// ─── Route-level: the 400 mapping at the stream-turn start ───────────────────

function makeRouteApp(throwFromAssert: Error | null) {
  const runtime = {
    experienceCopilotAssertStreamKind: async () => {
      if (throwFromAssert) throw throwFromAssert;
    },
    experienceCopilotStream: async function* () {
      yield { event: "finish", data: JSON.stringify({ finishReason: "stop" }) };
    },
  } as unknown as ExperienceCopilotRuntimeApi;
  return createExperienceCopilotRoutes(runtime);
}

describe("POST /api/experience-copilot/:threadId/stream kind-resolution mapping (AS-2c)", () => {
  test("an unserved script kind maps to a 400 JSON response carrying the error code", async () => {
    const app = makeRouteApp(new NoAgentKindForScriptKindError("dice"));
    const res = await app.request("/api/experience-copilot/thread_kr_1/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", providerProfileId: "prov_1" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("NO_AGENT_KIND_FOR_SCRIPT_KIND");
    expect(body.error).toContain('script kind "dice"');
  });

  test("a resolved kind proceeds to the SSE stream (no 400)", async () => {
    const app = makeRouteApp(null);
    const res = await app.request("/api/experience-copilot/thread_kr_1/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", providerProfileId: "prov_1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("finish");
  });
});
