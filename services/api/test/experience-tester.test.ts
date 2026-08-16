/**
 * Stateless unsaved-source Interactive-experience tester tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-81B).
 *
 * Pins behavior at the REAL boundary: HTTP transport → adapter → tester service
 * → real sandbox/kernel. The tester module is unit-tested directly against the
 * real kernel (no StoreContainer, no chat/session/DB — acceptance #6), and a
 * focused set of HTTP integration tests exercise the full route → adapter →
 * tester → kernel path plus the typed-error → HTTP-status mapping.
 *
 * mock.module is NOT used here, so these files are safe to run in any order.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
import { createExperienceRoutes } from "../src/api/routes/experience.js";
import { ExperienceAdapter } from "../src/api/adapters/experience-adapter.js";
import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceReplayService } from "../src/domain/interactive/experience-replay-service.js";
import {
  ExperienceContextService,
  type ExperienceChatLifecycleSeam,
} from "../src/domain/interactive/experience-context-service.js";
import { ExperienceModelEffectService } from "../src/domain/interactive/experience-model-effect-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import {
  runExperienceTest,
  simulateExperienceTest,
} from "../src/domain/interactive/experience-tester.js";

// ─── Shared rules sources (real, runnable experience bodies) ─────────────────

/** Minimal counter game: increment to 3 completes. Declares no capabilities. */
const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "counter", name: "Counter" }, capabilities: [],
  create() { console.log("created"); return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }, { type: "reset" }]; },
  reduce(c, a) {
    if (a.type === "reset") return { state: { count: 0 }, status: "active", events: [] };
    const n = c.state.count + 1;
    return { state: { count: n }, status: n >= 3 ? "completed" : "active", events: [{ visibility: "public", type: "inc", detail: { n } }] };
  },
});
`;

/** Declares `participants`; create reads its length (throws when not granted). */
const PARTICIPANTS_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "part", name: "Part" },
  capabilities: [{ capability: "participants" }],
  create(c) { return { seats: c.participants.length }; },
  project(c) { return { seats: c.state.seats }; },
  actions() { return [{ type: "noop" }]; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

/** reduce requests a durable model effect (reported, never executed). */
const EFFECT_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "eff", name: "Eff" }, capabilities: [],
  create() { return { asked: false }; },
  project(c) { return { asked: c.state.asked }; },
  actions() { return [{ type: "ask" }]; },
  reduce(c) {
    return {
      state: { asked: true }, status: "active",
      events: [{ visibility: "public", type: "asked" }],
      effects: [{ kind: "model", request: { viewer: "p1", mode: "text", actionType: "reply" } }],
    };
  },
});
`;

/** Script seat that counts to 3 then completes; declares `choose`. */
const SCRIPT_COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "sc", name: "SC" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions(c) { return c.state.n < 3 ? [{ type: "tick" }] : []; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: c.state.n + 1 >= 3 ? "completed" : "active", events: [] }; },
  choose(c, { legal }) { return legal[0]; },
});
`;

/** Script + human seats; script passes the turn to the human. */
const TURN_HANDOFF_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "th", name: "TH" }, capabilities: [],
  create() { return { turn: "script" }; },
  project(c) { return { turn: c.state.turn }; },
  actions(c, v) {
    if (v.participantId === "bot") return c.state.turn === "script" ? [{ type: "pass" }] : [];
    return c.state.turn === "human" ? [{ type: "go" }] : [];
  },
  reduce(c) { return { state: { turn: "human" }, status: "active", events: [] }; },
  choose(c, { legal }) { return legal[0]; },
});
`;

/** Script seat with legal actions but NO choose method (configuration error). */
const NO_CHOOSE_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "nc", name: "NC" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "tick" }]; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
});
`;

/** Script seat that never terminates and never hands off (bounded stop). */
const NON_TERMINATING_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "nt", name: "NT" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "tick" }]; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
  choose(c, { legal }) { return legal[0]; },
});
`;

/** No participant ever has a legal action (stuck at start). */
const STUCK_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "st", name: "ST" }, capabilities: [],
  create() { return {}; },
  project() { return {}; },
  actions() { return []; },
  reduce() { return { state: {}, status: "active", events: [] }; },
});
`;

const botScript = { id: "bot", label: "Bot", controller: "script" as const };
const youHuman = { id: "you", label: "You", controller: "human" as const };

// ─── 1. runExperienceTest — direct (real kernel, no DB) ──────────────────────

describe("runExperienceTest — real kernel (stateless)", () => {
  test("create-only run discovers, creates, projects, and lists legal actions", () => {
    const res = runExperienceTest({ rulesCode: COUNTER_SOURCE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.definition.manifest.id).toBe("counter");
    expect(res.data.sourceHash).toMatch(/^[0-9a-f]+$/);
    expect(res.data.revision).toBe(0);
    expect(res.data.status).toBe("active");
    expect(res.data.initialState).toEqual({ count: 0 });
    expect(res.data.finalState).toEqual({ count: 0 });
    expect(res.data.projection.state).toEqual({ count: 0 });
    expect(res.data.projection.actions.map((a) => a.type)).toEqual(["inc", "reset"]);
    expect(res.data.events).toEqual([]);
    expect(res.data.effects).toEqual([]);
    expect(res.data.steps).toEqual([]);
    // Real VM console was captured (the create() body logs "created").
    expect(res.data.console.some((e) => e.args.includes("created"))).toBe(true);
  });

  test("one action reduces through the real kernel and bumps the host revision", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [{ type: "inc", requestId: "r1", expectedRevision: 0 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.revision).toBe(1);
    expect(res.data.finalState).toEqual({ count: 1 });
    expect(res.data.initialState).toEqual({ count: 0 });
    expect(res.data.events.map((e) => e.type)).toEqual(["inc"]);
    expect(res.data.steps).toHaveLength(1);
    expect(res.data.steps[0]?.replayed).toBe(false);
    expect(res.data.steps[0]?.revision).toBe(1);
    expect(res.data.projection.state).toEqual({ count: 1 });
  });

  test("a terminal reduce stops the replay and reports completed status", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [
        { type: "inc", requestId: "r1", expectedRevision: 0 },
        { type: "inc", requestId: "r2", expectedRevision: 1 },
        { type: "inc", requestId: "r3", expectedRevision: 2 },
        // A fourth action would be ignored (status already completed).
        { type: "inc", requestId: "r4", expectedRevision: 3 },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("completed");
    expect(res.data.revision).toBe(3);
    expect(res.data.finalState).toEqual({ count: 3 });
    // The fourth action was ignored after completion (only 3 steps applied).
    expect(res.data.steps).toHaveLength(3);
  });

  test("an illegal action type returns the typed illegal_action error and persists nothing", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [{ type: "cheat", requestId: "r1", expectedRevision: 0 }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("illegal_action");
    expect(res.error.status).toBe(422);
  });

  test("a stale expectedRevision returns the typed stale_revision error with the live revision", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [
        { type: "inc", requestId: "r1", expectedRevision: 0 },
        { type: "inc", requestId: "r2", expectedRevision: 0 }, // stale: live is now 1
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("stale_revision");
    expect(res.error.status).toBe(409);
    expect(res.error.currentRevision).toBe(1);
  });

  test("a duplicate requestId is idempotent — it does not re-reduce or advance the revision", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [
        { type: "inc", requestId: "dup", expectedRevision: 0 },
        { type: "inc", requestId: "dup", expectedRevision: 1 }, // same requestId
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Only ONE revision bump; the duplicate replayed without re-reducing.
    expect(res.data.revision).toBe(1);
    expect(res.data.finalState).toEqual({ count: 1 });
    expect(res.data.steps).toHaveLength(2);
    expect(res.data.steps[0]?.replayed).toBe(false);
    expect(res.data.steps[1]?.replayed).toBe(true);
    expect(res.data.steps[1]?.revision).toBe(1); // unchanged by the replay
  });

  test("a duplicate requestId replays even when it carries a now-stale expectedRevision (idempotency precedes CAS)", () => {
    // Mirrors the persistent service: a retried duplicate carries the ORIGINAL
    // expectedRevision; idempotency is checked before CAS, so it does not 409.
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE,
      actions: [
        { type: "inc", requestId: "dup", expectedRevision: 0 },
        { type: "reset", requestId: "r2", expectedRevision: 1 },
        { type: "inc", requestId: "dup", expectedRevision: 0 }, // dup, stale revision
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.revision).toBe(2);
    expect(res.data.steps[2]?.replayed).toBe(true);
  });

  test("an over-granted capability (not declared by the rules) returns capability_denied", () => {
    const res = runExperienceTest({
      rulesCode: COUNTER_SOURCE, // declares no capabilities
      capabilityGrants: ["deterministic_random"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("capability_denied");
    expect(res.error.needs).toEqual(["deterministic_random"]);
  });

  test("a missing capability grant surfaces the kernel's existing typed error", () => {
    // PARTICIPANTS_SOURCE declares `participants` and reads c.participants.length
    // in create. With no grant, context.participants is undefined → TypeError →
    // the kernel's runtime error (vm_error). Granted, create succeeds.
    const denied = runExperienceTest({ rulesCode: PARTICIPANTS_SOURCE });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("vm_error");

    const granted = runExperienceTest({
      rulesCode: PARTICIPANTS_SOURCE,
      capabilityGrants: ["participants"],
      participants: [botScript, youHuman],
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.data.initialState).toEqual({ seats: 2 });
  });

  test("effects are reported, never executed", () => {
    const res = runExperienceTest({
      rulesCode: EFFECT_SOURCE,
      actions: [{ type: "ask", requestId: "r1", expectedRevision: 0 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The model-effect request is captured in the result...
    expect(res.data.effects).toHaveLength(1);
    expect(res.data.effects[0]?.kind).toBe("model");
    // ...and there is no execution surface in this tester: the request is
    // durable data the host would run out-of-band (Wave 4). Structural: the
    // run completed without any provider call, and the effect is unchanged.
    expect(res.data.finalState).toEqual({ asked: true });
  });

  test("a discovery failure returns the typed discovery error and runs no further step", () => {
    const broken = "context.experience.register({ apiVersion: 1, manifest: { id: 'x', name: 'X' } });";
    const res = runExperienceTest({ rulesCode: broken, settings: { irrelevant: true } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Missing mandatory methods → sandbox missing_method → vm_error.
    expect(res.error.code).toBe("vm_error");
    expect(res.error.kind).toBe("missing_method");
  });

  test("a syntax error in unsaved source returns the typed discovery error", () => {
    const res = runExperienceTest({ rulesCode: "this is not valid javascript ((" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("vm_error");
    expect(res.error.kind).toBe("syntax");
  });

  test("the same seed + action sequence reproduces identical deterministic draws", () => {
    // A reducer that draws from the deterministic random stream (granted).
    const seeded = `
      context.experience.register({
        apiVersion: 1, manifest: { id: "rng", name: "Rng" },
        capabilities: [{ capability: "deterministic_random" }],
        create(c) { return { roll: c.random.int(1, 1000) }; },
        project(c) { return { roll: c.state.roll }; },
        actions() { return [{ type: "reroll" }]; },
        reduce(c) { return { state: { roll: c.random.int(1, 1000) }, status: "active", events: [] }; },
      });
    `;
    const a = runExperienceTest({
      rulesCode: seeded,
      capabilityGrants: ["deterministic_random"],
      seed: "reproducible-seed",
      actions: [
        { type: "reroll", requestId: "r1", expectedRevision: 0 },
        { type: "reroll", requestId: "r2", expectedRevision: 1 },
      ],
    });
    const b = runExperienceTest({
      rulesCode: seeded,
      capabilityGrants: ["deterministic_random"],
      seed: "reproducible-seed",
      actions: [
        { type: "reroll", requestId: "r1", expectedRevision: 0 },
        { type: "reroll", requestId: "r2", expectedRevision: 1 },
      ],
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.initialState).toEqual(b.data.initialState);
    expect(a.data.finalState).toEqual(b.data.finalState);
  });
});

// ─── 2. simulateExperienceTest — real kernel (stateless) ─────────────────────

describe("simulateExperienceTest — real kernel (stateless)", () => {
  test("advances a script seat with choose to a terminal completion", () => {
    const res = simulateExperienceTest({
      rulesCode: SCRIPT_COUNTER_SOURCE,
      participants: [botScript],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("completed");
    expect(res.data.iterations).toBe(3);
    expect(res.data.revision).toBe(3);
    expect(res.data.status).toBe("completed");
    expect(res.data.finalState).toEqual({ n: 3 });
  });

  test("stops at the human boundary after a script hands off the turn", () => {
    const res = simulateExperienceTest({
      rulesCode: TURN_HANDOFF_SOURCE,
      // Roster order matters for findActor: bot (script) checked first.
      participants: [botScript, youHuman],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("awaiting_human");
    expect(res.data.iterations).toBe(1);
    expect(res.data.revision).toBe(1);
  });

  test("a script seat with legal actions but no choose returns the configuration-error diagnostic", () => {
    const res = simulateExperienceTest({
      rulesCode: NO_CHOOSE_SOURCE,
      participants: [botScript],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("no_choose_method");
    expect(res.data.stopDetail?.participantId).toBe("bot");
    expect(res.data.iterations).toBe(0);
  });

  test("a no-legal-action position returns the stuck diagnostic", () => {
    const res = simulateExperienceTest({
      rulesCode: STUCK_SOURCE,
      participants: [botScript],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("no_legal_action");
    expect(res.data.iterations).toBe(0);
  });

  test("a non-terminating loop stops at the host bound with bounded_non_termination", () => {
    const res = simulateExperienceTest({
      rulesCode: NON_TERMINATING_SOURCE,
      participants: [botScript],
      maxIterations: 5,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("bounded_non_termination");
    expect(res.data.iterations).toBe(5);
    expect(res.data.revision).toBe(5);
    expect(res.data.status).toBe("active");
  });

  test("a model-controlled seat is reported as the awaiting_model boundary", () => {
    const modelSeat = { id: "m1", label: "Model", controller: "model" as const };
    const res = simulateExperienceTest({
      rulesCode: `
        context.experience.register({
          apiVersion: 1, manifest: { id: "ms", name: "MS" }, capabilities: [],
          create() { return {}; },
          project() { return {}; },
          actions() { return [{ type: "speak" }]; },
          reduce() { return { state: {}, status: "active", events: [] }; },
        });
      `,
      participants: [modelSeat],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("awaiting_model");
    expect(res.data.iterations).toBe(0);
  });

  test("simulation reports effects per step and never executes them", () => {
    // A script seat whose reduce always requests a model effect.
    const res = simulateExperienceTest({
      rulesCode: `
        context.experience.register({
          apiVersion: 1, manifest: { id: "se", name: "SE" }, capabilities: [],
          create() { return { n: 0 }; },
          project(c) { return { n: c.state.n }; },
          actions(c) { return c.state.n < 2 ? [{ type: "tick" }] : []; },
          reduce(c) {
            return {
              state: { n: c.state.n + 1 },
              status: c.state.n + 1 >= 2 ? "completed" : "active",
              events: [],
              effects: [{ kind: "model", request: { viewer: "bot", mode: "action" } }],
            };
          },
          choose(c, { legal }) { return legal[0]; },
        });
      `,
      participants: [botScript],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("completed");
    // Two steps, each requested an effect — reported, not executed.
    expect(res.data.effects).toHaveLength(2);
    expect(res.data.effects.every((e) => e.kind === "model")).toBe(true);
  });
});

// ─── 3. HTTP integration — route → adapter → tester → real kernel ────────────

function mount(runtime: ReturnType<typeof buildAdapter>) {
  const app = createExperienceRoutes(runtime);
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

async function jsonBody(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

function buildAdapter(stores: StoreContainer): ExperienceAdapter {
  const resources = new ExperienceResourceService(stores);
  const lifecycle = new ExperienceService(stores, resources, { generateSeed: () => "seed1" });
  const replay = new ExperienceReplayService(stores, resources);
  const providerProfiles = createProviderProfileService(stores.providers, stores.proxies);
  const chatLifecycle: ExperienceChatLifecycleSeam = {
    assembleSummaryPrompt: async () => {
      throw new Error("Compact-summary execution is outside this tester fixture.");
    },
  };
  const contextService = new ExperienceContextService({ stores, providerProfiles, chatLifecycle });
  const modelEffect = new ExperienceModelEffectService({
    stores,
    experienceService: lifecycle,
    contextService,
    providerProfiles,
  });
  return new ExperienceAdapter(lifecycle, resources, replay, modelEffect, contextService);
}

async function setupTesterApp() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-tester-"));
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  return mount(buildAdapter(stores));
}

describe("Experience tester routes — integration (real adapter + kernel)", () => {
  test("POST /api/experience/test/run reduces one action through the real kernel", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        actions: [{ type: "inc", requestId: "r1", expectedRevision: 0 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.revision).toBe(1);
    expect(body.finalState).toEqual({ count: 1 });
    expect(body.projection.state).toEqual({ count: 1 });
    expect(body.definition.manifest.id).toBe("counter");
  });

  test("a stale expectedRevision is 409 stale_revision with currentRevision", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        actions: [
          { type: "inc", requestId: "r1", expectedRevision: 0 },
          { type: "inc", requestId: "r2", expectedRevision: 0 },
        ],
      }),
    });
    expect(res.status).toBe(409);
    const body = await jsonBody(res);
    expect(body.error.details.code).toBe("stale_revision");
    expect(body.error.details.currentRevision).toBe(1);
  });

  test("an illegal action is 422 illegal_action", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        actions: [{ type: "cheat", requestId: "r1", expectedRevision: 0 }],
      }),
    });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).error.details.code).toBe("illegal_action");
  });

  test("an over-granted capability is 422 capability_denied", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        capabilityGrants: ["rp_context"],
      }),
    });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).error.details.code).toBe("capability_denied");
  });

  test("a discovery failure is 422 and surfaces the console on the error path", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rulesCode: "(((" }),
    });
    expect(res.status).toBe(422);
    const body = await jsonBody(res);
    expect(body.error.details.code).toBe("vm_error");
    expect(body.error.details.kind).toBe("syntax");
    // The diagnostic surface preserves captured console on the error path.
    expect(Array.isArray(body.error.details.console)).toBe(true);
  });

  test("POST /api/experience/test/simulate runs the bounded script loop", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: SCRIPT_COUNTER_SOURCE,
        participants: [botScript],
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.stopReason).toBe("completed");
    expect(body.iterations).toBe(3);
    expect(body.revision).toBe(3);
  });

  test("schema rejection: a run body missing rulesCode is 400", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("schema rejection: simulate maxIterations out of range is 400", async () => {
    const app = await setupTesterApp();
    const res = await app.request("/api/experience/test/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rulesCode: COUNTER_SOURCE, maxIterations: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
