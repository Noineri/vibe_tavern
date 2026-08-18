/**
 * IR-71B_client_store — server-authoritative per-chat+branch experience store.
 *
 * Pins the store boundary (mocked network only): fresh-scope hydration of
 * config/session/effects/attachment/report/context metadata, the normal 404
 * `no_active_session` empty state, scope isolation, stale-scope and same-scope
 * generation guards, action requestId mint/join idempotency with the CAS
 * revision taken from the current server session, success+failure resync with
 * inspectable structured errors, queued-attachment stability across session
 * advances, exact server responses for lifecycle/effect/context/report
 * actions, the one-time current-scope visibility listener (SSR-safe), and
 * local-only modal/detached flags.
 *
 * The twelve experience-api calls are mocked via the spread-real-then-override
 * pattern, keeping the genuine `ExperienceApiError` class for the 404/409/500
 * paths; the store module is imported AFTER mock registration.
 */
import { beforeEach, describe, expect, test, mock } from "bun:test";
import type {
  ExperienceActionRequest,
  ExperienceActionResponse,
  ExperienceChatConfigRow,
  ExperienceContextCaptureRequest,
  ExperienceContextStatusDto,
  ExperienceEffectRow,
  ExperienceEffectRunResponse,
  ExperienceFinishRequest,
  ExperienceQueuedAttachmentResponse,
  ExperienceQueuedAttachmentView,
  ExperienceReportQueueRequest,
  ExperienceReportStatus,
  ExperienceRestartRequest,
  ExperienceSessionResponse,
  ExperienceStartRequest,
} from "../api/types.js";
import type { ExperienceApiError as ExperienceApiErrorType } from "../api/experience-api.js";
import type { ExperienceActionIntent } from "./experience-store.js";

// ── Mock the experience-api network layer (spread real, override the calls) ──

interface Impl {
  getExperienceConfig: (chatId: string) => Promise<ExperienceChatConfigRow>;
  getActiveExperienceSession: (chatId: string, branchId: string) => Promise<ExperienceSessionResponse>;
  getExperienceEffects: (sessionId: string) => Promise<ExperienceEffectRow[]>;
  getExperienceQueuedAttachment: (sessionId: string) => Promise<ExperienceQueuedAttachmentResponse>;
  getExperienceReportStatus: (sessionId: string) => Promise<ExperienceReportStatus>;
  getExperienceContextStatus: (sessionId: string) => Promise<ExperienceContextStatusDto | null>;
  startExperienceSession: (chatId: string, body: ExperienceStartRequest) => Promise<ExperienceSessionResponse>;
  endExperienceSession: (sessionId: string, body: ExperienceFinishRequest) => Promise<ExperienceQueuedAttachmentResponse>;
  restartExperienceSession: (sessionId: string, body: ExperienceRestartRequest) => Promise<ExperienceSessionResponse>;
  submitExperienceAction: (
    sessionId: string,
    body: ExperienceActionRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ExperienceActionResponse>;
  queueExperienceReport: (sessionId: string, body: ExperienceReportQueueRequest) => Promise<ExperienceQueuedAttachmentView>;
  runExperienceEffect: (effectId: string, options?: { signal?: AbortSignal }) => Promise<ExperienceEffectRunResponse>;
  captureExperienceContext: (
    sessionId: string,
    body: ExperienceContextCaptureRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ExperienceContextStatusDto>;
}

let impl: Impl;
const actionCalls: Array<{ sessionId: string; body: ExperienceActionRequest }> = [];
const startCalls: Array<{ chatId: string; body: ExperienceStartRequest }> = [];
const endCalls: Array<{ sessionId: string; body: ExperienceFinishRequest }> = [];
const restartCalls: Array<{ sessionId: string; body: ExperienceRestartRequest }> = [];
const queueCalls: Array<{ sessionId: string; body: ExperienceReportQueueRequest }> = [];

const realExperienceApi = await import("../api/experience-api.js");
mock.module("../api/experience-api.js", () => {
  return {
    ...realExperienceApi,
    getExperienceConfig: (chatId: string) => impl.getExperienceConfig(chatId),
    getActiveExperienceSession: (chatId: string, branchId: string) => impl.getActiveExperienceSession(chatId, branchId),
    getExperienceEffects: (sessionId: string) => impl.getExperienceEffects(sessionId),
    getExperienceQueuedAttachment: (sessionId: string) => impl.getExperienceQueuedAttachment(sessionId),
    getExperienceReportStatus: (sessionId: string) => impl.getExperienceReportStatus(sessionId),
    getExperienceContextStatus: (sessionId: string) => impl.getExperienceContextStatus(sessionId),
    startExperienceSession: (chatId: string, body: ExperienceStartRequest) => {
      startCalls.push({ chatId, body });
      return impl.startExperienceSession(chatId, body);
    },
    endExperienceSession: (sessionId: string, body: ExperienceFinishRequest) => {
      endCalls.push({ sessionId, body });
      return impl.endExperienceSession(sessionId, body);
    },
    restartExperienceSession: (sessionId: string, body: ExperienceRestartRequest) => {
      restartCalls.push({ sessionId, body });
      return impl.restartExperienceSession(sessionId, body);
    },
    submitExperienceAction: (sessionId: string, body: ExperienceActionRequest, options?: { signal?: AbortSignal }) => {
      actionCalls.push({ sessionId, body });
      return impl.submitExperienceAction(sessionId, body, options);
    },
    queueExperienceReport: (sessionId: string, body: ExperienceReportQueueRequest) => {
      queueCalls.push({ sessionId, body });
      return impl.queueExperienceReport(sessionId, body);
    },
    runExperienceEffect: (effectId: string, options?: { signal?: AbortSignal }) => impl.runExperienceEffect(effectId, options),
    captureExperienceContext: (sessionId: string, body: ExperienceContextCaptureRequest, options?: { signal?: AbortSignal }) =>
      impl.captureExperienceContext(sessionId, body, options),
  };
});

const { ExperienceApiError } = await import("../api/experience-api.js");
const { useExperienceStore, resetExperienceStoreForTests } = await import("./experience-store.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const C1 = "c1";
const C2 = "c2";
const B1 = "b1";
const B2 = "b2";
const S1 = "sess-1";
const KEY_C1B1 = JSON.stringify([C1, B1]);
const KEY_C1B2 = JSON.stringify([C1, B2]);
const KEY_C2B1 = JSON.stringify([C2, B1]);

const T0 = "2026-01-01T00:00:00Z";

function makeConfig(chatId: string): ExperienceChatConfigRow {
  return {
    id: `cfg-${chatId}`,
    chatId,
    enabled: true,
    scriptId: "script-1",
    visualId: "vis-1",
    capabilityGrants: [],
    contextMode: "none",
    contextSourceCharacterId: null,
    contextSourceChatId: null,
    contextSourcePersonaId: null,
    launcherVisible: true,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeSession(overrides: Partial<ExperienceSessionResponse> = {}): ExperienceSessionResponse {
  return {
    sessionId: S1,
    chatId: C1,
    branchId: B1,
    manifest: { id: "game-1", name: "Test Game" },
    apiVersion: 1,
    status: "active",
    revision: 1,
    reportFrontier: 0,
    view: { state: {}, actions: [], revision: 1, status: "active" },
    capabilityGrants: [],
    contextMode: "none",
    participants: [{ id: "p1", label: "Hero", controller: "human" }],
    rulesRevision: 1,
    rulesSourceHash: "hash-1",
    visualId: null,
    visualSource: null,
    visualSourceHash: null,
    ...overrides,
  };
}

function makeActionResponse(overrides: Partial<ExperienceActionResponse> = {}): ExperienceActionResponse {
  return { ...makeSession({ revision: 2 }), events: [], await: "human", ...overrides };
}

function makeEffect(overrides: Partial<ExperienceEffectRow> = {}): ExperienceEffectRow {
  return {
    id: "eff-1",
    sessionId: S1,
    kind: "model_turn",
    status: "pending",
    originatingRevision: 1,
    requestJson: "{}",
    resultJson: null,
    error: null,
    attemptCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<ExperienceQueuedAttachmentView> = {}): ExperienceQueuedAttachmentView {
  return {
    id: "att-1",
    chatId: C1,
    branchId: B1,
    sessionId: S1,
    sessionRevision: 1,
    queueRevision: 1,
    kind: "report",
    publicReport: { title: "Test Game", events: [] },
    rulesSourceHash: "hash-1",
    visualSourceHash: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeReportStatus(overrides: Partial<ExperienceReportStatus> = {}): ExperienceReportStatus {
  return { revision: 1, reportFrontier: 0, pendingPublicEventCount: 0, queuedAttachment: null, ...overrides };
}

function makeContextStatus(overrides: Partial<ExperienceContextStatusDto> = {}): ExperienceContextStatusDto {
  return {
    sessionId: S1,
    mode: "recent",
    branchFrontierRevision: 1,
    messageFrontierPosition: 5,
    providerProfileId: "prof-1",
    modelId: "model-1",
    sourceCharacterId: null,
    sourceChatId: null,
    sourcePersonaId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function noActiveSession(branchId: string): ExperienceApiErrorType {
  return new ExperienceApiError(404, `No active experience session for branch '${branchId}'`, "no_active_session");
}

function intent(overrides: Partial<ExperienceActionIntent> = {}): ExperienceActionIntent {
  return { type: "move", ...overrides };
}

function scopeState(key: string) {
  return useExperienceStore.getState().byScope[key];
}

async function pump(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("waitFor: condition not reached");
}

/** Await the fire-and-forget rehydrate kicked off by setScope. */
async function flushScope(key: string): Promise<void> {
  await waitFor(() => {
    const scope = scopeState(key);
    return scope !== undefined && scope.loading === false;
  });
}

/** Deterministically seed an active scope: the awaited explicit rehydrate
 *  supersedes setScope's fire-and-forget one via the generation guard. */
async function seedActiveScope(session: ExperienceSessionResponse, chatId: string = C1, branchId: string = B1): Promise<void> {
  impl.getActiveExperienceSession = async () => session;
  useExperienceStore.getState().setScope(chatId, branchId);
  await useExperienceStore.getState().rehydrate(chatId, branchId);
}

beforeEach(() => {
  resetExperienceStoreForTests();
  actionCalls.length = 0;
  startCalls.length = 0;
  endCalls.length = 0;
  restartCalls.length = 0;
  queueCalls.length = 0;
  impl = {
    getExperienceConfig: async (chatId) => makeConfig(chatId),
    getActiveExperienceSession: async (_chatId, branchId) => {
      throw noActiveSession(branchId);
    },
    getExperienceEffects: async () => [],
    getExperienceQueuedAttachment: async () => null,
    getExperienceReportStatus: async () => makeReportStatus(),
    getExperienceContextStatus: async () => null,
    startExperienceSession: async () => makeSession(),
    endExperienceSession: async () => null,
    restartExperienceSession: async () => makeSession({ sessionId: "sess-restarted", revision: 1 }),
    submitExperienceAction: async () => makeActionResponse(),
    queueExperienceReport: async () => makeAttachment(),
    runExperienceEffect: async (effectId) => ({ effect: makeEffect({ id: effectId, status: "completed" }), delivered: true }),
    captureExperienceContext: async () => makeContextStatus(),
  };
});

// ── Fresh-scope hydration ────────────────────────────────────────────────────

describe("experience-store — fresh scope hydration", () => {
  test("setScope hydrates config + active session + effects + attachment/report/context metadata", async () => {
    const session = makeSession({ capabilityGrants: ["rp_context"] });
    const effect = makeEffect();
    const attachment = makeAttachment();
    const context = makeContextStatus();
    impl.getActiveExperienceSession = async () => session;
    impl.getExperienceEffects = async () => [effect];
    impl.getExperienceQueuedAttachment = async () => attachment;
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: attachment });
    impl.getExperienceContextStatus = async () => context;

    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);

    expect(useExperienceStore.getState().activeScope).toEqual({ chatId: C1, branchId: B1 });
    const scope = scopeState(KEY_C1B1);
    expect(scope?.config?.chatId).toBe(C1);
    expect(scope?.session?.sessionId).toBe(S1);
    expect(scope?.effects.map((e) => e.id)).toEqual([effect.id]);
    expect(scope?.queuedAttachment?.id).toBe(attachment.id);
    expect(scope?.reportStatus?.revision).toBe(1);
    expect(scope?.contextStatus?.sessionId).toBe(S1);
    expect(scope?.loading).toBe(false);
    expect(scope?.lastError).toBeNull();
    expect(scope?.lastApiError).toBeNull();
  });

  test("context status is NOT fetched without the rp_context grant (capability absence is not an error)", async () => {
    let contextStatusCalls = 0;
    impl.getActiveExperienceSession = async () => makeSession({ capabilityGrants: ["model"] });
    impl.getExperienceContextStatus = async () => {
      contextStatusCalls += 1;
      return makeContextStatus();
    };

    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);

    expect(contextStatusCalls).toBe(0);
    expect(scopeState(KEY_C1B1)?.contextStatus).toBeNull();
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
  });
});

// ── Session discovery: normal empty vs real errors ───────────────────────────

describe("experience-store — session discovery", () => {
  test("404 no_active_session is the normal session:null state, clearing session-owned resources without an error", async () => {
    // Seed a live session first so the clearing behavior is observable.
    await seedActiveScope(makeSession({ capabilityGrants: ["rp_context"] }));
    impl.getExperienceEffects = async () => [makeEffect()];
    impl.getExperienceQueuedAttachment = async () => makeAttachment();
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: makeAttachment() });
    impl.getExperienceContextStatus = async () => makeContextStatus();
    await useExperienceStore.getState().rehydrate(C1, B1);
    expect(scopeState(KEY_C1B1)?.session).not.toBeNull();

    // The session ends elsewhere; discovery now answers the empty code.
    impl.getActiveExperienceSession = async (_c, branchId) => {
      throw noActiveSession(branchId);
    };
    await useExperienceStore.getState().rehydrate(C1, B1);

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session).toBeNull();
    expect(scope?.effects).toEqual([]);
    // IR-73C/D: queuedAttachment is intentionally preserved across
    // no-active-session discovery until an authoritative refresh clears it.
    expect(scope?.queuedAttachment?.id).toBe("att-1");
    expect(scope?.reportStatus).toBeNull();
    expect(scope?.contextStatus).toBeNull();
    expect(scope?.lastError).toBeNull();
    expect(scope?.lastApiError).toBeNull();
    // Config still loads on the empty branch.
    expect(scope?.config?.chatId).toBe(C1);
  });

  test("a non-404 discovery error populates lastError and keeps the cached session", async () => {
    const session = makeSession({ revision: 3 });
    await seedActiveScope(session);
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(3);

    impl.getActiveExperienceSession = async () => {
      throw new ExperienceApiError(500, "discovery down", "internal");
    };
    await useExperienceStore.getState().refreshSession(C1, B1);

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.revision).toBe(3); // valid cached data is not erased
    expect(scope?.lastError).toBe("discovery down");
    expect(scope?.lastApiError).toBeInstanceOf(ExperienceApiError);
    expect(scope?.lastApiError?.status).toBe(500);
    expect(scope?.lastApiError?.code).toBe("internal");
  });
});

// ── Chat/branch isolation ────────────────────────────────────────────────────

describe("experience-store — scope isolation", () => {
  test("sessions, resources, and errors stay isolated per chat+branch key", async () => {
    const sessionB1 = makeSession({ sessionId: "sess-b1", branchId: B1, revision: 1 });
    const sessionB2 = makeSession({ sessionId: "sess-b2", branchId: B2, revision: 5 });
    const sessionC2 = makeSession({ sessionId: "sess-c2", chatId: C2, branchId: B1, revision: 9 });
    impl.getActiveExperienceSession = async (chatId, branchId) => {
      if (chatId === C2) return sessionC2;
      return branchId === B1 ? sessionB1 : sessionB2;
    };
    impl.getExperienceEffects = async (sessionId) =>
      sessionId === "sess-b2" ? [makeEffect({ id: "eff-b2", sessionId })] : [];

    await useExperienceStore.getState().rehydrate(C1, B1);
    await useExperienceStore.getState().rehydrate(C1, B2);
    await useExperienceStore.getState().rehydrate(C2, B1);

    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe("sess-b1");
    expect(scopeState(KEY_C1B2)?.session?.sessionId).toBe("sess-b2");
    expect(scopeState(KEY_C1B2)?.session?.revision).toBe(5);
    expect(scopeState(KEY_C2B1)?.session?.sessionId).toBe("sess-c2");
    expect(scopeState(KEY_C1B2)?.effects.map((e) => e.id)).toEqual(["eff-b2"]);
    expect(scopeState(KEY_C1B1)?.effects).toEqual([]);

    // A refresh error on B2 does not leak into B1.
    impl.getActiveExperienceSession = async (chatId, branchId) => {
      if (chatId === C1 && branchId === B2) throw new ExperienceApiError(500, "b2 down", "internal");
      if (chatId === C2) return sessionC2;
      return sessionB1;
    };
    await useExperienceStore.getState().refreshSession(C1, B2);
    expect(scopeState(KEY_C1B2)?.lastError).toBe("b2 down");
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe("sess-b1");
  });
});

// ── Stale-scope + same-scope generation guards ───────────────────────────────

describe("experience-store — race guards", () => {
  test("A→B switch discards the late A response entirely (no stale A repopulation, no B overwrite)", async () => {
    const sessionA = makeSession({ sessionId: "sess-a", revision: 1 });
    const sessionB = makeSession({ sessionId: "sess-b", branchId: B2, revision: 2 });
    let resolveA: ((session: ExperienceSessionResponse) => void) | null = null;
    impl.getActiveExperienceSession = (_chatId, branchId) => {
      if (branchId === B1) {
        return new Promise<ExperienceSessionResponse>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(sessionB);
    };

    useExperienceStore.getState().setScope(C1, B1); // rehydrate A in flight
    useExperienceStore.getState().setScope(C1, B2); // switch: A's generation is invalidated
    await flushScope(KEY_C1B2);
    expect(scopeState(KEY_C1B2)?.session?.sessionId).toBe("sess-b");

    // The obsolete A request resolves late — it must write nowhere.
    if (!resolveA) throw new Error("expected the A discovery to be in flight");
    (resolveA as (session: ExperienceSessionResponse) => void)(sessionA);
    await pump();

    expect(scopeState(KEY_C1B1)?.session ?? null).toBeNull();
    expect(scopeState(KEY_C1B1)?.config ?? null).toBeNull();
    expect(scopeState(KEY_C1B2)?.session?.sessionId).toBe("sess-b");
  });

  test("overlapping same-scope rehydrates keep only the newest response", async () => {
    const older = makeSession({ sessionId: "sess-old", revision: 1 });
    const newer = makeSession({ sessionId: "sess-new", revision: 7 });
    const resolvers: Array<(session: ExperienceSessionResponse) => void> = [];
    impl.getActiveExperienceSession = () =>
      new Promise<ExperienceSessionResponse>((resolve) => {
        resolvers.push(resolve);
      });

    const first = useExperienceStore.getState().rehydrate(C1, B1); // generation 1
    const second = useExperienceStore.getState().rehydrate(C1, B1); // generation 2 supersedes
    resolvers[1](newer); // newest resolves first
    await second;
    resolvers[0](older); // obsolete generation resolves late
    await first;

    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe("sess-new");
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(7);
  });

  test("a focused refresh cannot cancel a full rehydrate or strand loading=true", async () => {
    await seedActiveScope(makeSession({ revision: 1 }));
    let resolveDiscovery: ((session: ExperienceSessionResponse) => void) | null = null;
    impl.getActiveExperienceSession = () =>
      new Promise<ExperienceSessionResponse>((resolve) => {
        resolveDiscovery = resolve;
      });
    const refreshedEffect = makeEffect({ id: "eff-refreshed" });
    impl.getExperienceEffects = async () => [refreshedEffect];

    const hydration = useExperienceStore.getState().rehydrate(C1, B1);
    await waitFor(() => resolveDiscovery !== null);
    expect(scopeState(KEY_C1B1)?.loading).toBe(true);

    await useExperienceStore.getState().refreshEffects(C1, B1);
    expect(scopeState(KEY_C1B1)?.effects.map((effect) => effect.id)).toEqual(["eff-refreshed"]);

    if (!resolveDiscovery) throw new Error("expected session discovery to be in flight");
    (resolveDiscovery as (session: ExperienceSessionResponse) => void)(makeSession({ revision: 2 }));
    await hydration;

    expect(scopeState(KEY_C1B1)?.loading).toBe(false);
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(2);
    expect(scopeState(KEY_C1B1)?.effects.map((effect) => effect.id)).toEqual(["eff-refreshed"]);
  });

  test("a mutation completing after A→B does not rehydrate or update obsolete scope A", async () => {
    await seedActiveScope(makeSession({ revision: 1 }));
    let resolveAction: ((response: ExperienceActionResponse) => void) | null = null;
    impl.submitExperienceAction = () =>
      new Promise<ExperienceActionResponse>((resolve) => {
        resolveAction = resolve;
      });

    let obsoleteDiscoveries = 0;
    const sessionB = makeSession({ sessionId: "sess-b", branchId: B2, revision: 5 });
    impl.getActiveExperienceSession = async (_chatId, branchId) => {
      if (branchId === B1) {
        obsoleteDiscoveries += 1;
        return makeSession({ revision: 2 });
      }
      return sessionB;
    };

    const action = useExperienceStore.getState().submitAction(intent());
    useExperienceStore.getState().setScope(C1, B2);
    await flushScope(KEY_C1B2);

    if (!resolveAction) throw new Error("expected an action request in flight");
    (resolveAction as (response: ExperienceActionResponse) => void)(makeActionResponse({ revision: 2 }));
    await action;

    expect(obsoleteDiscoveries).toBe(0);
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(1);
    expect(scopeState(KEY_C1B2)?.session?.sessionId).toBe("sess-b");
    expect(scopeState(KEY_C1B2)?.session?.revision).toBe(5);
  });
});

// ── Action idempotency + CAS revision ────────────────────────────────────────

describe("experience-store — submitAction", () => {
  test("distinct payloads are distinct intents: separate HTTP calls, separate requestIds, CAS revision from the current server session", async () => {
    await seedActiveScope(makeSession({ revision: 3 }));
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(3);

    const resolvers: Array<(response: ExperienceActionResponse) => void> = [];
    impl.submitExperienceAction = () =>
      new Promise<ExperienceActionResponse>((resolve) => {
        resolvers.push(resolve);
      });
    impl.getActiveExperienceSession = async () => makeSession({ revision: 4 });

    const p1 = useExperienceStore.getState().submitAction(intent());
    const p2 = useExperienceStore.getState().submitAction(intent({ payload: { x: 1 } }));
    expect(actionCalls).toHaveLength(2); // no join across different intents
    expect(actionCalls[0].body.requestId).not.toBe(actionCalls[1].body.requestId);
    expect(actionCalls[0].body.expectedRevision).toBe(3);
    expect(actionCalls[1].body.expectedRevision).toBe(3);

    for (const resolve of resolvers) resolve(makeActionResponse({ revision: 4 }));
    await Promise.all([p1, p2]);
    expect(scopeState(KEY_C1B1)?.actionRequestIds).toEqual({});
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(4);
  });

  test("concurrent identical intents join one in-flight request (one HTTP call, one requestId)", async () => {
    await seedActiveScope(makeSession({ revision: 3 }));

    let resolveAction: ((response: ExperienceActionResponse) => void) | null = null;
    impl.submitExperienceAction = () =>
      new Promise<ExperienceActionResponse>((resolve) => {
        resolveAction = resolve;
      });
    impl.getActiveExperienceSession = async () => makeSession({ revision: 4 });

    const p1 = useExperienceStore.getState().submitAction(intent());
    const p2 = useExperienceStore.getState().submitAction(intent());
    expect(actionCalls).toHaveLength(1); // joined: no duplicate HTTP call
    expect(actionCalls[0].body.expectedRevision).toBe(3); // CAS from the current server session
    const firstRequestId = actionCalls[0].body.requestId;
    expect(typeof firstRequestId).toBe("string");
    expect(firstRequestId.length).toBeGreaterThan(0);

    if (!resolveAction) throw new Error("expected an action request in flight");
    const response = makeActionResponse({ revision: 4 });
    (resolveAction as (response: ExperienceActionResponse) => void)(response);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(response);
    expect(r2).toBe(response); // both callers share the joined result

    // Settled: the in-flight key cleared, the resync refreshed the session.
    expect(scopeState(KEY_C1B1)?.actionRequestIds).toEqual({});
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(4);

    // A deliberate later action mints a NEW requestId and calls the API again.
    impl.submitExperienceAction = async () => makeActionResponse({ revision: 5 });
    impl.getActiveExperienceSession = async () => makeSession({ revision: 5 });
    const later = await useExperienceStore.getState().submitAction(intent());
    expect(later).not.toBeNull();
    expect(actionCalls).toHaveLength(2);
    expect(actionCalls[1].body.requestId).not.toBe(firstRequestId);
    expect(actionCalls[1].body.expectedRevision).toBe(4); // revision tracked the resync
  });

  test("submitAction without an active session rejects locally without calling the API", async () => {
    useExperienceStore.getState().setScope(C1, B1); // default impl: no active session
    await flushScope(KEY_C1B1);
    expect(scopeState(KEY_C1B1)?.session).toBeNull();

    await expect(useExperienceStore.getState().submitAction(intent())).rejects.toThrow("requires an active session");
    expect(actionCalls).toHaveLength(0);
  });
});

// ── Mutation resync: success + failure ───────────────────────────────────────

describe("experience-store — mutation resync", () => {
  test("action success resyncs the session from the server", async () => {
    await seedActiveScope(makeSession({ revision: 3 }));
    impl.submitExperienceAction = async () => makeActionResponse({ revision: 4 });
    impl.getActiveExperienceSession = async () => makeSession({ revision: 4 });

    const result = await useExperienceStore.getState().submitAction(intent());
    expect(result?.revision).toBe(4);
    expect(scopeState(KEY_C1B1)?.session?.revision).toBe(4);
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
  });

  test("409 stale_revision resyncs (server wins) and keeps the structured error inspectable", async () => {
    await seedActiveScope(makeSession({ revision: 3 }));
    // Another client moved the session to revision 7.
    impl.submitExperienceAction = async () => {
      throw new ExperienceApiError(409, "Stale revision", "stale_revision", { currentRevision: 7 });
    };
    impl.getActiveExperienceSession = async () => makeSession({ revision: 7 });

    const result = await useExperienceStore.getState().submitAction(intent());
    expect(result).toBeNull();

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.revision).toBe(7); // server state wins after the failure resync
    expect(scope?.lastError).toBe("Stale revision");
    expect(scope?.lastApiError).toBeInstanceOf(ExperienceApiError);
    expect(scope?.lastApiError?.status).toBe(409);
    expect(scope?.lastApiError?.code).toBe("stale_revision");
    expect(scope?.lastApiError?.details?.currentRevision).toBe(7);
    expect(scope?.actionRequestIds).toEqual({}); // in-flight key cleared on failure too
  });
});

// ── Queued-attachment stability ──────────────────────────────────────────────

describe("experience-store — queued attachment", () => {
  test("a session advance never grows the queued attachment locally; only a queueReport/refresh response replaces it", async () => {
    const pinned = makeAttachment({ id: "att-1", sessionRevision: 1, queueRevision: 1 });
    impl.getExperienceQueuedAttachment = async () => pinned;
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: pinned });
    await seedActiveScope(makeSession({ revision: 1 }));
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-1");

    // The session advances to revision 2; the server keeps the SAME queued
    // attachment (it never expands silently).
    impl.submitExperienceAction = async () => makeActionResponse({ revision: 2 });
    impl.getActiveExperienceSession = async () => makeSession({ revision: 2 });
    await useExperienceStore.getState().submitAction(intent());

    let scope = scopeState(KEY_C1B1);
    expect(scope?.session?.revision).toBe(2);
    expect(scope?.queuedAttachment?.id).toBe("att-1");
    expect(scope?.queuedAttachment?.sessionRevision).toBe(1);
    expect(scope?.queuedAttachment?.queueRevision).toBe(1);

    // Explicit queue at the current server revision replaces the attachment
    // with the server's response.
    const requeued = makeAttachment({ id: "att-2", sessionRevision: 2, queueRevision: 2 });
    impl.queueExperienceReport = async () => requeued;
    impl.getExperienceQueuedAttachment = async () => requeued;
    impl.getExperienceReportStatus = async () => makeReportStatus({ revision: 2, reportFrontier: 2, queuedAttachment: requeued });
    const result = await useExperienceStore.getState().queueReport();

    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].body.expectedRevision).toBe(2);
    expect(result?.id).toBe("att-2");
    scope = scopeState(KEY_C1B1);
    expect(scope?.queuedAttachment?.id).toBe("att-2");
    expect(scope?.queuedAttachment?.queueRevision).toBe(2);
  });
});

// ── Lifecycle / effect / context actions ─────────────────────────────────────

describe("experience-store — lifecycle + effect + context actions", () => {
  test("startSession submits branch+settings+participants and reflects the server session after resync", async () => {
    useExperienceStore.getState().setScope(C1, B1); // no active session initially
    await flushScope(KEY_C1B1);
    expect(scopeState(KEY_C1B1)?.session).toBeNull();

    const started = makeSession({ revision: 1 });
    impl.startExperienceSession = async () => started;
    impl.getActiveExperienceSession = async () => started;

    const participants: ExperienceStartRequest["participants"] = [{ id: "p1", label: "Hero", controller: "human" }];
    const result = await useExperienceStore.getState().startSession({ difficulty: "hard" }, participants);

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].chatId).toBe(C1);
    expect(startCalls[0].body.branchId).toBe(B1);
    expect(startCalls[0].body.settings).toEqual({ difficulty: "hard" });
    expect(startCalls[0].body.participants).toEqual(participants);
    expect(result?.sessionId).toBe(S1);
    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe(S1);
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
  });

  test("startSession conflict (branch_has_active) resyncs to the server's active session and surfaces the error", async () => {
    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);

    const existing = makeSession({ sessionId: "sess-existing", revision: 4 });
    impl.startExperienceSession = async () => {
      throw new ExperienceApiError(409, "Branch already has an active session", "branch_has_active");
    };
    impl.getActiveExperienceSession = async () => existing;

    const result = await useExperienceStore.getState().startSession();
    expect(result).toBeNull();
    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.sessionId).toBe("sess-existing"); // server wins
    expect(scope?.lastApiError?.code).toBe("branch_has_active");
  });

  test("endSession pins the current revision and retains the terminal attachment after the resync clears session resources", async () => {
    const attachment = makeAttachment();
    impl.getExperienceQueuedAttachment = async () => attachment;
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: attachment });
    await seedActiveScope(makeSession({ revision: 6 }));
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-1");

    const terminal = makeAttachment({ id: "att-terminal", sessionRevision: 6 });
    impl.endExperienceSession = async () => terminal;
    impl.getActiveExperienceSession = async (_c, branchId) => {
      throw noActiveSession(branchId);
    };

    const result = await useExperienceStore.getState().endSession();
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0].sessionId).toBe(S1);
    expect(endCalls[0].body.expectedRevision).toBe(6);
    expect(result?.id).toBe("att-terminal"); // terminal snapshot returned to the caller

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session).toBeNull();
    expect(scope?.effects).toEqual([]);
    // IR-73C/D: the exact terminal attachment is retained as queuedAttachment
    // after the no-active-session rehydrate cleared session resources.
    expect(scope?.queuedAttachment).toBe(terminal);
    expect(scope?.reportStatus).toBeNull();
    expect(scope?.lastError).toBeNull();
  });

  test("restartSession sends the scope's sessionId with an EMPTY body, then a plain rehydrate discovers the successor", async () => {
    await seedActiveScope(makeSession({ sessionId: S1, revision: 6 }));

    const successor = makeSession({ sessionId: "sess-successor", revision: 1 });
    impl.restartExperienceSession = async () => successor;
    impl.getActiveExperienceSession = async () => successor;

    const result = await useExperienceStore.getState().restartSession();

    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0].sessionId).toBe(S1);
    // Empty body = restart with the source match's frozen snapshots (Б3 one-shot).
    expect(restartCalls[0].body).toEqual({});
    expect(result?.sessionId).toBe("sess-successor"); // the NEW session is returned
    expect(result?.status).toBe("active");
    // The plain rehydrate discovered the successor as the branch's active
    // session — no terminal writeback path (unlike endSession).
    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe("sess-successor");
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
  });

  test("restartSession API failure returns null and populates lastError after the resync", async () => {
    await seedActiveScope(makeSession({ sessionId: S1, revision: 6 }));

    impl.restartExperienceSession = async () => {
      throw new ExperienceApiError(409, "Restart rejected", "branch_has_active");
    };

    const result = await useExperienceStore.getState().restartSession();
    expect(result).toBeNull();

    const scope = scopeState(KEY_C1B1);
    expect(scope?.lastError).toBe("Restart rejected");
    expect(scope?.lastApiError).toBeInstanceOf(ExperienceApiError);
    expect(scope?.lastApiError?.status).toBe(409);
    expect(scope?.lastApiError?.code).toBe("branch_has_active");
    // The failure resync kept the server's active session authoritative.
    expect(scope?.session?.sessionId).toBe(S1);
  });

  test("runEffect reflects the terminal effect row after resync", async () => {
    const pending = makeEffect({ id: "eff-1", status: "pending" });
    impl.getExperienceEffects = async () => [pending];
    await seedActiveScope(makeSession({ revision: 2 }));
    expect(scopeState(KEY_C1B1)?.effects[0]?.status).toBe("pending");

    const completed = makeEffect({ id: "eff-1", status: "completed", resultJson: "{\"ok\":true}" });
    const advanced = makeSession({ revision: 3 });
    impl.runExperienceEffect = async (effectId) => ({ effect: completed, delivered: true, session: advanced });
    impl.getExperienceEffects = async () => [completed];
    impl.getActiveExperienceSession = async () => advanced;

    const result = await useExperienceStore.getState().runEffect("eff-1");
    expect(result?.delivered).toBe(true);
    expect(result?.effect.status).toBe("completed");
    const scope = scopeState(KEY_C1B1);
    expect(scope?.effects[0]?.status).toBe("completed");
    expect(scope?.session?.revision).toBe(3);
  });

  test("captureContext reflects the server context status after resync", async () => {
    await seedActiveScope(makeSession({ capabilityGrants: ["rp_context"] }));
    expect(scopeState(KEY_C1B1)?.contextStatus).toBeNull(); // never captured

    const captured = makeContextStatus({ mode: "compact_summary", branchFrontierRevision: 9 });
    impl.captureExperienceContext = async () => captured;
    impl.getExperienceContextStatus = async () => captured;

    const body: ExperienceContextCaptureRequest = { mode: "compact_summary", providerProfileId: "prof-1", model: "model-1" };
    const result = await useExperienceStore.getState().captureContext(body);

    expect(result?.mode).toBe("compact_summary");
    expect(result?.branchFrontierRevision).toBe(9);
    expect(scopeState(KEY_C1B1)?.contextStatus?.branchFrontierRevision).toBe(9);
    expect(scopeState(KEY_C1B1)?.lastError).toBeNull();
  });
});

// ── Visibility rehydrate listener ────────────────────────────────────────────

describe("experience-store — visibility listener", () => {
  test("registers once, rehydrates only the current active scope on visible refocus, and ignores hidden", async () => {
    const handlers: Array<() => void> = [];
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: (_type: string, handler: () => void) => {
        handlers.push(handler);
      },
    };
    Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true, writable: true });
    try {
      const sessionB = makeSession({ sessionId: "sess-b", branchId: B2 });
      impl.getActiveExperienceSession = async (_c, branchId) => {
        if (branchId === B2) return sessionB;
        throw noActiveSession(branchId);
      };
      useExperienceStore.getState().setScope(C1, B1);
      await flushScope(KEY_C1B1);
      useExperienceStore.getState().setScope(C1, B2);
      await flushScope(KEY_C1B2);
      expect(handlers).toHaveLength(1); // one-time registration across scopes

      const discovered: string[] = [];
      impl.getActiveExperienceSession = async (_c, branchId) => {
        discovered.push(branchId);
        if (branchId === B2) return sessionB;
        throw noActiveSession(branchId);
      };
      const handler = handlers[0];
      if (!handler) throw new Error("expected a registered visibilitychange handler");
      handler();
      await waitFor(() => discovered.length > 0);
      expect(discovered).toEqual([B2]); // current scope only

      fakeDocument.visibilityState = "hidden";
      discovered.length = 0;
      handler();
      await pump();
      expect(discovered).toEqual([]); // hidden refocus does nothing
    } finally {
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("setScope is SSR-safe without a document and still rehydrates", async () => {
    expect(typeof document).toBe("undefined");
    const session = makeSession();
    impl.getActiveExperienceSession = async () => session;
    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);
    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe(S1);
  });
});

// ── Local-only UI flags ──────────────────────────────────────────────────────

describe("experience-store — local UI flags", () => {
  test("openModal/closeModal/setDetached are local and never mutate authoritative state", async () => {
    const session = makeSession({ revision: 3 });
    await seedActiveScope(session);
    const before = scopeState(KEY_C1B1);
    if (!before) throw new Error("expected a seeded scope");
    const { config, session: s0, effects, queuedAttachment, reportStatus, contextStatus, lastError } = before;

    useExperienceStore.getState().openModal();
    useExperienceStore.getState().setDetached(true);
    let scope = scopeState(KEY_C1B1);
    expect(scope?.modalOpen).toBe(true);
    expect(scope?.detached).toBe(true);
    expect(scope?.config).toBe(config);
    expect(scope?.session).toBe(s0);
    expect(scope?.effects).toBe(effects);
    expect(scope?.queuedAttachment).toBe(queuedAttachment);
    expect(scope?.reportStatus).toBe(reportStatus);
    expect(scope?.contextStatus).toBe(contextStatus);
    expect(scope?.lastError).toBe(lastError);

    useExperienceStore.getState().closeModal();
    useExperienceStore.getState().setDetached(false);
    scope = scopeState(KEY_C1B1);
    expect(scope?.modalOpen).toBe(false);
    expect(scope?.detached).toBe(false);
    // Closing the modal never ends the session (Wave 6 invariant).
    expect(scope?.session?.sessionId).toBe(S1);
    expect(endCalls).toHaveLength(0);
  });

  test("UI flag controls without an active scope are a no-op", () => {
    useExperienceStore.getState().openModal();
    useExperienceStore.getState().closeModal();
    useExperienceStore.getState().setDetached(true);
    expect(useExperienceStore.getState().byScope).toEqual({});
  });
});

// ── IR-70G: pinned visual source retention in the store ─────────────────────

describe("experience-store — pinned visual source retention (IR-70G)", () => {
  test("rehydrate retains the exact pinned visualSource/visualSourceHash from the API", async () => {
    const pinnedSource = "<board id='v1'/>";
    const pinnedHash = "hash-visual-abc";
    const session = makeSession({
      visualId: "vis-1",
      visualSource: pinnedSource,
      visualSourceHash: pinnedHash,
    });
    impl.getActiveExperienceSession = async () => session;
    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.visualSource).toBe(pinnedSource);
    expect(scope?.session?.visualSourceHash).toBe(pinnedHash);
    expect(scope?.session?.visualId).toBe("vis-1");
  });

  test("a later live visual resource edit is irrelevant: the store does not call visual CRUD to reconnect", async () => {
    const pinnedSource = "<board id='v1'/>";
    const pinnedHash = "hash-visual-abc";
    const session = makeSession({
      visualId: "vis-1",
      visualSource: pinnedSource,
      visualSourceHash: pinnedHash,
    });
    await seedActiveScope(session);

    // The mock module does not expose visual CRUD functions at all — the store
    // has no way to call getExperienceVisual. Assert the pinned values survive
    // a mutation resync (which triggers a rehydrate discovery) unchanged.
    impl.getActiveExperienceSession = async () =>
      makeSession({ visualId: "vis-1", visualSource: pinnedSource, visualSourceHash: pinnedHash, revision: 2 });
    impl.submitExperienceAction = async () => makeActionResponse({
      visualId: "vis-1", visualSource: pinnedSource, visualSourceHash: pinnedHash, revision: 2,
    });

    const result = await useExperienceStore.getState().submitAction(intent());
    expect(result?.visualSource).toBe(pinnedSource);
    expect(result?.visualSourceHash).toBe(pinnedHash);

    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.visualSource).toBe(pinnedSource);
    expect(scope?.session?.visualSourceHash).toBe(pinnedHash);
  });

  test("startSession retains the exact pinned visualSource/visualSourceHash from the server", async () => {
    useExperienceStore.getState().setScope(C1, B1);
    await flushScope(KEY_C1B1);
    expect(scopeState(KEY_C1B1)?.session).toBeNull();

    const started = makeSession({
      visualId: "vis-2",
      visualSource: "<canvas/>",
      visualSourceHash: "hash-canvas",
    });
    impl.startExperienceSession = async () => started;
    impl.getActiveExperienceSession = async () => started;

    const result = await useExperienceStore.getState().startSession();
    expect(result?.visualSource).toBe("<canvas/>");
    expect(result?.visualSourceHash).toBe("hash-canvas");
    expect(result?.visualId).toBe("vis-2");
    expect(scopeState(KEY_C1B1)?.session?.visualSource).toBe("<canvas/>");
    expect(scopeState(KEY_C1B1)?.session?.visualSourceHash).toBe("hash-canvas");
  });

  test("a no-visual session has explicit null visualSource/visualSourceHash in the store", async () => {
    await seedActiveScope(makeSession());
    const scope = scopeState(KEY_C1B1);
    expect(scope?.session?.visualId).toBeNull();
    expect(scope?.session?.visualSource).toBeNull();
    expect(scope?.session?.visualSourceHash).toBeNull();
  });
});

// ── IR-73C/D: terminal Finish writeback + retention ───────────────────────

describe("experience-store — terminal Finish writeback (IR-73C/D)", () => {
  test("null terminal response clears the retained intent rather than preserving stale data", async () => {
    const attachment = makeAttachment();
    impl.getExperienceQueuedAttachment = async () => attachment;
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: attachment });
    await seedActiveScope(makeSession({ revision: 6 }));
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-1");

    impl.endExperienceSession = async () => null;
    impl.getActiveExperienceSession = async (_c, branchId) => { throw noActiveSession(branchId); };

    const result = await useExperienceStore.getState().endSession();
    expect(result).toBeNull();
    // The nullable terminal response clears the retained intent.
    expect(scopeState(KEY_C1B1)?.queuedAttachment).toBeNull();
  });

  test("no-active-session rehydrate/refocus preserves a retained terminal intent", async () => {
    await seedActiveScope(makeSession({ revision: 6 }));
    const terminal = makeAttachment({ id: "att-terminal", sessionRevision: 6 });
    impl.endExperienceSession = async () => terminal;
    impl.getActiveExperienceSession = async (_c, branchId) => { throw noActiveSession(branchId); };

    await useExperienceStore.getState().endSession();
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-terminal");

    // A subsequent refocus rehydrate (tab regained visibility) must NOT clear
    // the retained terminal intent.
    await useExperienceStore.getState().rehydrate(C1, B1);
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-terminal");
    expect(scopeState(KEY_C1B1)?.session).toBeNull();
  });

  test("refreshAttachment without active session uses retained sessionId and clears/replaces from server", async () => {
    await seedActiveScope(makeSession({ revision: 6 }));
    const terminal = makeAttachment({ id: "att-terminal", sessionId: S1 });
    impl.endExperienceSession = async () => terminal;
    impl.getActiveExperienceSession = async (_c, branchId) => { throw noActiveSession(branchId); };
    await useExperienceStore.getState().endSession();
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-terminal");
    expect(scopeState(KEY_C1B1)?.session).toBeNull();

    // Server says the attachment is gone: refreshAttachment uses the retained
    // terminal's sessionId to fetch, then clears.
    impl.getExperienceQueuedAttachment = async () => null;
    await useExperienceStore.getState().refreshAttachment(C1, B1);
    expect(scopeState(KEY_C1B1)?.queuedAttachment).toBeNull();
  });

  test("refreshAttachment without active session replaces from a non-null server response", async () => {
    await seedActiveScope(makeSession({ revision: 6 }));
    const terminal = makeAttachment({ id: "att-terminal", sessionId: S1 });
    impl.endExperienceSession = async () => terminal;
    impl.getActiveExperienceSession = async (_c, branchId) => { throw noActiveSession(branchId); };
    await useExperienceStore.getState().endSession();

    const replaced = makeAttachment({ id: "att-replaced", sessionId: S1 });
    impl.getExperienceQueuedAttachment = async () => replaced;
    await useExperienceStore.getState().refreshAttachment(C1, B1);
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-replaced");
  });

  test("new active session hydration replaces the terminal cached intent", async () => {
    await seedActiveScope(makeSession({ revision: 6 }));
    const terminal = makeAttachment({ id: "att-terminal", sessionRevision: 6 });
    impl.endExperienceSession = async () => terminal;
    impl.getActiveExperienceSession = async (_c, branchId) => { throw noActiveSession(branchId); };
    await useExperienceStore.getState().endSession();
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-terminal");

    // A new session starts on the same branch; its queued attachment replaces
    // the retained terminal.
    const newSession = makeSession({ sessionId: "sess-new", revision: 1 });
    const newAttachment = makeAttachment({ id: "att-new", sessionId: "sess-new" });
    impl.getActiveExperienceSession = async () => newSession;
    impl.getExperienceQueuedAttachment = async () => newAttachment;
    impl.getExperienceReportStatus = async () => makeReportStatus({ queuedAttachment: newAttachment });
    await useExperienceStore.getState().rehydrate(C1, B1);

    expect(scopeState(KEY_C1B1)?.session?.sessionId).toBe("sess-new");
    expect(scopeState(KEY_C1B1)?.queuedAttachment?.id).toBe("att-new");
  });

  test("stale Finish completion after active-scope change does not contaminate new active scope", async () => {
    await seedActiveScope(makeSession({ revision: 6 }));

    let resolveEnd: ((response: ExperienceQueuedAttachmentResponse) => void) | null = null;
    impl.endExperienceSession = () =>
      new Promise<ExperienceQueuedAttachmentResponse>((resolve) => { resolveEnd = resolve; });

    const sessionB = makeSession({ sessionId: "sess-b", branchId: B2, revision: 5 });
    impl.getActiveExperienceSession = async (_c, branchId) => {
      if (branchId === B1) throw noActiveSession(branchId);
      return sessionB;
    };

    // Kick off endSession on scope C1/B1, then switch to C1/B2 while it is
    // in flight.
    const endPromise = useExperienceStore.getState().endSession();
    useExperienceStore.getState().setScope(C1, B2);
    await flushScope(KEY_C1B2);

    const terminal = makeAttachment({ id: "att-terminal", chatId: C1, branchId: B1, sessionId: S1 });
    if (!resolveEnd) throw new Error("expected endExperienceSession in flight");
    (resolveEnd as (response: ExperienceQueuedAttachmentResponse) => void)(terminal);
    const result = await endPromise;

    // The terminal is returned to the caller...
    expect(result?.id).toBe("att-terminal");
    // ...but NOT written into the new active scope C1/B2.
    expect(scopeState(KEY_C1B2)?.queuedAttachment).toBeNull();
    expect(scopeState(KEY_C1B2)?.session?.sessionId).toBe("sess-b");
  });
});
