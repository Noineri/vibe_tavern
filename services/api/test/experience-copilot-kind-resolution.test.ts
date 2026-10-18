import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
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
  AgentKindNotWiredError,
  registerAgentKind,
} from "../src/domain/agent/agent-kind-registry.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
// Side-effect import: registers the `script` agent kind (AS-7) so the
// prompt/dice resolution this suite pins holds regardless of which test file
// the shared process loaded first.
import "../src/domain/agent/kinds/script-kind.js";
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
 * script kind — the mapping itself is the unit under pin there. Since AS-8b
 * the STREAM DISPATCHES by the resolved kind (prompt/dice scripts run the
 * `script` kind's assembly through this endpoint), so the assert only rejects
 * what NO registered kind serves. The truly-unserved case (a bogus script
 * kind value) still throws `NoAgentKindForScriptKindError`.
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

  test("a script kind NO registered kind serves throws NoAgentKindForScriptKindError", async () => {
    // AS-7 note: every real script kind is served now (interactive →
    // experience, prompt/dice → script), so the unserved branch is pinned on
    // a bogus kind value — order-independent by construction.
    const adapter = makeAdapter(makeThread(), makeScriptRow("bogus"));
    let caught: unknown;
    try {
      await adapter.experienceCopilotAssertStreamKind("thread_kr_1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoAgentKindForScriptKindError);
    const error = caught as NoAgentKindForScriptKindError;
    expect(error.code).toBe("NO_AGENT_KIND_FOR_SCRIPT_KIND");
    expect(error.scriptKind).toBe("bogus");
  });

  test("a prompt/dice script (the AS-7 `script` kind) resolves and reaches the registered kind (AS-8b dispatch)", async () => {
    // Pre-AS-8b this pinned the refusal (`copilot_thread_kind_mismatch`);
    // the stream now DISPATCHES script threads to the `script` kind's
    // assembly, so the assert must let them through — only an UNSERVED kind
    // 400s before the SSE headers.
    for (const scriptKind of ["prompt", "dice"]) {
      const adapter = makeAdapter(makeThread(), makeScriptRow(scriptKind));
      await expect(adapter.experienceCopilotAssertStreamKind("thread_kr_1")).resolves.toBeUndefined();
    }
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

// ─── Dispatch: the stream runs the wiring of the RESOLVED kind (AS-8b-fix-A) ──
//
// The kind table is private to the adapter, so the wiring is observed through
// the true external boundary: a local stand-in for the provider's
// chat-completions endpoint records the request the stream sends. The script
// kind's assembly carries the script API-knowledge section; the experience
// kind's carries the interactive-rules reference.

const SCRIPT_PROMPT_API_MARKER = "deterministic Script Engine";
const SCRIPT_DICE_API_MARKER = "Dice Script Engine";
const EXPERIENCE_API_MARKER = "context.experience.register";

const requestBodies: string[] = [];
const providerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requestBodies.push(await req.text());
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    const body =
      chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

afterAll(async () => {
  await providerServer.stop(true);
});

function makeProviderRow() {
  return {
    id: "prov_1",
    name: "Test",
    providerPreset: "openai",
    coauthorTransport: "chatCompletions",
    endpoint: `http://127.0.0.1:${providerServer.port}/v1`,
    apiKey: "sk-test",
    defaultModel: "test-model",
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 2000,
    temperature: 0.3,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: null,
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: null,
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: "inherit",
    proxyId: null,
    isActive: true,
    visionModel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Adapter over a store container that supports a full stream turn for either
 *  kind (thread store with persistence + script row + provider row). */
function makeStreamAdapter(thread: ExperienceCopilotThread, script: ScriptRow | null) {
  const messages: Array<Record<string, unknown>> = [];
  let counter = 0;
  const store = {
    async getById(threadId: string) {
      return thread.id === threadId ? thread : null;
    },
    async listMessages() {
      return [...messages];
    },
    async appendMessage(_threadId: string, input: { role: string; content?: string; toolCallsJson?: string | null; toolCallId?: string | null }) {
      const msg = {
        id: `msg_${counter++}`,
        threadId: thread.id,
        role: input.role,
        content: input.content ?? "",
        toolCallsJson: input.toolCallsJson ?? null,
        toolCallId: input.toolCallId ?? null,
        createdAt: new Date(Date.now() + counter * 1000).toISOString(),
      };
      messages.push(msg);
      return msg;
    },
    async updateContextMetrics() {},
    async updateTodo() {},
  } as unknown as ExperienceCopilotStore;
  const providerRow = makeProviderRow();
  const stores = {
    experienceCopilot: store,
    agentPlans: { get: async () => null, save: async () => {} },
    scripts: {
      async getById(scriptId: string) {
        return script && script.id === scriptId ? script : null;
      },
      async getLinks() { return []; },
      async getBoundVisualIds() { return []; },
    },
    characters: { async getById() { return null; } },
    personas: { async getById() { return null; } },
    providers: {
      async getById(id: string) { return id === providerRow.id ? providerRow : null; },
      async getModelSettings() { return null; },
    },
    copilotProfiles: { async getById() { return null; } },
    experienceResources: { async getVisualById() { return null; } },
  } as unknown as StoreContainer;
  return new ExperienceCopilotAdapter(stores);
}

async function runStream(adapter: ExperienceCopilotAdapter): Promise<string[]> {
  const events: string[] = [];
  const gen = adapter.experienceCopilotStream("thread_kr_1", {
    content: "hello",
    providerProfileId: "prov_1",
  });
  for await (const chunk of gen) events.push(chunk.event);
  return events;
}

describe("ExperienceCopilotAdapter.experienceCopilotStream - dispatch by resolved kind (AS-8b-fix-A)", () => {
  beforeEach(() => {
    requestBodies.length = 0;
  });

  test("a prompt thread runs the SCRIPT wiring", async () => {
    const adapter = makeStreamAdapter(makeThread(), makeScriptRow("prompt"));
    const events = await runStream(adapter);
    expect(events).toContain("finish");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain(SCRIPT_PROMPT_API_MARKER);
    expect(requestBodies[0]).not.toContain(EXPERIENCE_API_MARKER);
  });

  test("a dice thread runs the SCRIPT wiring (dice API section)", async () => {
    const adapter = makeStreamAdapter(makeThread(), makeScriptRow("dice"));
    const events = await runStream(adapter);
    expect(events).toContain("finish");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain(SCRIPT_DICE_API_MARKER);
    expect(requestBodies[0]).not.toContain(EXPERIENCE_API_MARKER);
  });

  test("an interactive thread runs the EXPERIENCE wiring", async () => {
    const adapter = makeStreamAdapter(makeThread(), makeScriptRow("interactive"));
    const events = await runStream(adapter);
    expect(events).toContain("finish");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain(EXPERIENCE_API_MARKER);
    expect(requestBodies[0]).not.toContain(SCRIPT_PROMPT_API_MARKER);
    expect(requestBodies[0]).not.toContain(SCRIPT_DICE_API_MARKER);
  });

  test("a draft thread (scriptId null) and a dangling script link run the EXPERIENCE wiring", async () => {
    for (const adapter of [
      makeStreamAdapter(makeThread(null), null),
      makeStreamAdapter(makeThread(), null),
    ]) {
      requestBodies.length = 0;
      const events = await runStream(adapter);
      expect(events).toContain("finish");
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toContain(EXPERIENCE_API_MARKER);
      expect(requestBodies[0]).not.toContain(SCRIPT_PROMPT_API_MARKER);
    }
  });
});

/** The fake-kind fixture the unwired-kind tests share (AS-8b-fix-A,
 *  AS-10h): a kind the registry serves for a script kind the adapter tables
 *  have no entry for — registered only inside a test's try/finally. */
function makeUnwiredFakeKind(): AgentKind {
  return {
    id: "kr-fake-unwired",
    servesScriptKinds: ["kr-fake-script-kind"],
    basePromptServiceKey: "kr_fake",
    skillRootId: "kr-fake",
    toolSetSchema: {},
    defaultToolSet: {},
  } as unknown as AgentKind;
}

describe("ExperienceCopilotAdapter - a resolved kind without a stream-table entry (AS-8b-fix-A)", () => {
  test("400s in the assert step (before streaming) with AgentKindNotWiredError", async () => {
    // A kind the registry serves for a script kind the adapter has no wiring
    // for: the assert step must refuse it before the route sends SSE headers.
    // AS-10h: the wiring bug is its own typed error, not an unknown kind.
    const unregister = registerAgentKind(makeUnwiredFakeKind());
    try {
      const adapter = makeStreamAdapter(makeThread(), makeScriptRow("kr-fake-script-kind"));
      let caught: unknown;
      try {
        await adapter.experienceCopilotAssertStreamKind("thread_kr_1");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentKindNotWiredError);
      expect((caught as AgentKindNotWiredError).kindId).toBe("kr-fake-unwired");
      expect((caught as AgentKindNotWiredError).table).toBe("stream");
      expect((caught as AgentKindNotWiredError).code).toBe("AGENT_KIND_NOT_WIRED");

      // The stream itself never falls back to another kind's wiring either.
      const gen = adapter.experienceCopilotStream("thread_kr_1", { content: "hi", providerProfileId: "prov_1" });
      await expect(gen.next()).rejects.toBeInstanceOf(AgentKindNotWiredError);
    } finally {
      unregister();
    }
  });

  test("the route maps it to a 400 JSON response carrying the error code", async () => {
    const app = makeRouteApp(new AgentKindNotWiredError("kr-fake-unwired", "stream"));
    const res = await app.request("/api/experience-copilot/thread_kr_1/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", providerProfileId: "prov_1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("AGENT_KIND_NOT_WIRED");
  });
});

describe("ExperienceCopilotAdapter script stream - context cards and script-library skill pins (AS-8e1)", () => {
  /** Adapter over a store container with linkable character/persona rows
   *  (the script kind's card sources) plus both skill libraries. */
  function makeCardAdapter(
    thread: ExperienceCopilotThread,
    script: ScriptRow | null,
    opts: {
      links?: Array<{ targetType: "character" | "persona"; targetId: string }>;
      scriptSkillService?: SkillLibraryService;
      copilotSkillService?: SkillLibraryService;
    } = {},
  ) {
    const messages: Array<Record<string, unknown>> = [];
    let counter = 0;
    const store = {
      async getById(threadId: string) {
        return thread.id === threadId ? thread : null;
      },
      async listMessages() {
        return [...messages];
      },
      async appendMessage(_threadId: string, input: { role: string; content?: string; toolCallsJson?: string | null; toolCallId?: string | null }) {
        const msg = {
          id: `msg_${counter++}`,
          threadId: thread.id,
          role: input.role,
          content: input.content ?? "",
          toolCallsJson: input.toolCallsJson ?? null,
          toolCallId: input.toolCallId ?? null,
          createdAt: new Date(Date.now() + counter * 1000).toISOString(),
        };
        messages.push(msg);
        return msg;
      },
      async updateContextMetrics() {},
      async updateTodo() {},
    } as unknown as ExperienceCopilotStore;
    const providerRow = makeProviderRow();
    const stores = {
      experienceCopilot: store,
      agentPlans: { get: async () => null, save: async () => {} },
      scripts: {
        async getById(scriptId: string) {
          return script && script.id === scriptId ? script : null;
        },
        async getLinks() {
          return (opts.links ?? []).map((l) => ({ scriptId: script?.id ?? "script_kr_1", ...l }));
        },
        async getBoundVisualIds() { return []; },
      },
      characters: {
        async getById(id: string) {
          return id === "char_kr_9" ? { id, name: "Aria" } : null;
        },
        async getProfileMdText(id: string) {
          return `# Aria\n\nFULL-CARD-ARIA-MARKER for ${id}`;
        },
      },
      personas: {
        async getById(id: string) {
          return id === "persona_kr_7"
            ? { id, name: "Muse", description: "PERSONA-DESC-MUSE-MARKER" }
            : null;
        },
      },
      lorebooks: {
        async getLorebook() { return null; },
        async listEntries() { return []; },
      },
      providers: {
        async getById(id: string) { return id === providerRow.id ? providerRow : null; },
        async getModelSettings() { return null; },
      },
      copilotProfiles: { async getById() { return null; } },
      experienceResources: { async getVisualById() { return null; } },
    } as unknown as StoreContainer;
    return new ExperienceCopilotAdapter(
      stores,
      undefined,
      opts.copilotSkillService,
      opts.scriptSkillService,
    );
  }

  test("a skill pinned in a script thread resolves from the script library, never the experience one", async () => {
    // The same skill id exists in BOTH libraries with different bodies: the
    // script turn must inject the script library's body (the AS-8e1 skill-pin
    // leak was the experience library winning here).
    const root = await mkdtemp(join(tmpdir(), "vt-kr-skill-libs-"));
    try {
      const scriptUser = join(root, "script-user");
      const expUser = join(root, "exp-user");
      await mkdir(join(scriptUser, "shared-skill"), { recursive: true });
      await mkdir(join(expUser, "shared-skill"), { recursive: true });
      await mkdir(join(root, "script-builtin"), { recursive: true });
      await mkdir(join(root, "exp-builtin"), { recursive: true });
      await Bun.write(
        join(scriptUser, "shared-skill", "SKILL.md"),
        "---\nname: shared-skill\ndescription: Shared test skill.\n---\n\n# shared-skill\n\nSCRIPT-LIBRARY-SKILL-BODY-MARKER\n",
      );
      await Bun.write(
        join(expUser, "shared-skill", "SKILL.md"),
        "---\nname: shared-skill\ndescription: Shared test skill.\n---\n\n# shared-skill\n\nEXPERIENCE-LIBRARY-SKILL-BODY-MARKER\n",
      );
      const scriptSkillService = new SkillLibraryService(scriptUser, join(root, "script-builtin"));
      const copilotSkillService = new SkillLibraryService(expUser, join(root, "exp-builtin"));
      const thread: ExperienceCopilotThread = {
        ...makeThread(),
        contextLinks: [{ targetType: "skill", targetId: "shared-skill" }],
      };
      const adapter = makeCardAdapter(thread, makeScriptRow("prompt"), {
        scriptSkillService,
        copilotSkillService,
      });

      requestBodies.length = 0;
      const events = await runStream(adapter);
      expect(events).toContain("finish");
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toContain("SCRIPT-LIBRARY-SKILL-BODY-MARKER");
      expect(requestBodies[0]).not.toContain("EXPERIENCE-LIBRARY-SKILL-BODY-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("linked owners render full cards; a request id matching an owner renders once", async () => {
    const thread = makeThread();
    const adapter = makeCardAdapter(thread, makeScriptRow("prompt"), {
      links: [{ targetType: "character", targetId: "char_kr_9" }],
    });

    requestBodies.length = 0;
    const events: string[] = [];
    const gen = adapter.experienceCopilotStream("thread_kr_1", {
      content: "hello",
      providerProfileId: "prov_1",
      // The build-panel character is the SAME row as the linked owner — its
      // card must render exactly once — while the build-panel persona is
      // context only (a card, never an owner name).
      contextCharacterId: "char_kr_9",
      contextPersonaId: "persona_kr_7",
    });
    for await (const chunk of gen) events.push(chunk.event);
    expect(events).toContain("finish");
    expect(requestBodies).toHaveLength(1);
    const body = requestBodies[0] as string;
    // The owners line stays names-only: the linked character, never the
    // request-only persona (the request body is JSON, so the line ends at
    // the escaped newline right after the owner's name).
    expect(body).toContain("- Linked owners: Aria\\n");
    // The shared id renders once (dedupe by type+id across owners + request).
    expect(body.match(/### Character: Aria/g)).toHaveLength(1);
    expect(body.match(/FULL-CARD-ARIA-MARKER/g)).toHaveLength(1);
    // The request-only persona renders its full description as a card.
    expect(body).toContain("### Persona: Muse");
    expect(body).toContain("PERSONA-DESC-MUSE-MARKER");
  });
});

describe("ExperienceCopilotAdapter - a resolved kind without a compaction-table entry (AS-10h)", () => {
  test("compacting its thread 400s through the compact route with AGENT_KIND_NOT_WIRED", async () => {
    // The REAL adapter seam (thread → script row → registry → compaction
    // table miss) behind the real compact route: the wiring bug surfaces as
    // the 400 JSON shape (before AS-10h it was an unhandled 500).
    const unregister = registerAgentKind(makeUnwiredFakeKind());
    try {
      const store = {
        async getById(threadId: string) {
          return threadId === "thread_kr_1" ? makeThread() : null;
        },
      } as unknown as ExperienceCopilotStore;
      const stores = {
        experienceCopilot: store,
        scripts: {
          async getById(scriptId: string) {
            return scriptId === "script_kr_1" ? makeScriptRow("kr-fake-script-kind") : null;
          },
        },
      } as unknown as StoreContainer;
      // A non-empty compaction table (the built-ins) the fake kind is not in;
      // the empty object stands in for the provider profile service, which
      // this path never reaches (the throw happens at the table lookup).
      const adapter = new ExperienceCopilotAdapter(stores, {} as unknown as ProviderProfileService);
      const app = createExperienceCopilotRoutes(adapter);
      const res = await app.request("/api/experience-copilot/thread_kr_1/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("AGENT_KIND_NOT_WIRED");
      expect(body.error).toContain("compaction");
    } finally {
      unregister();
    }
  });
});
