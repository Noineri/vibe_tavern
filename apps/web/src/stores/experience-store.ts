import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type {
  ExperienceActionRequest,
  ExperienceActionResponse,
  ExperienceChatConfigRow,
  ExperienceContextCaptureRequest,
  ExperienceContextStatusDto,
  ExperienceEffectRow,
  ExperienceEffectRunResponse,
  ExperienceQueuedAttachmentResponse,
  ExperienceQueuedAttachmentView,
  ExperienceReportStatus,
  ExperienceSessionResponse,
  ExperienceStartRequest,
} from "../api/types.js";
import {
  ExperienceApiError,
  captureExperienceContext,
  endExperienceSession,
  getActiveExperienceSession,
  getExperienceConfig,
  getExperienceContextStatus,
  getExperienceEffects,
  getExperienceQueuedAttachment,
  getExperienceReportStatus,
  queueExperienceReport,
  runExperienceEffect,
  startExperienceSession,
  submitExperienceAction,
} from "../api/experience-api.js";

/**
 * Experience session store (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 /
 * IR-71B_client_store).
 *
 * A server-authoritative mirror of the per-`{chatId, branchId}` interactive
 * experience surface: the chat config row, the branch's active session
 * (metadata + projected view), durable effect rows, the privacy-safe queued
 * attachment, the report status, and the capability-gated context status.
 * The store NEVER executes rules locally and NEVER fabricates authoritative
 * state — no locally reduced projections, no hidden checkpoints, no raw
 * context bundles, no provider keys. Every mutation ends in a server resync
 * (`rehydrate`); the server wins on both success and 4xx/5xx (stale-revision
 * recovery resyncs, then surfaces the structured error).
 *
 * Session discovery: `getActiveExperienceSession` answers 404
 * `no_active_session` for an empty branch — exactly that code is the normal
 * `session: null` state; any other error populates `lastError`/`lastApiError`
 * WITHOUT erasing valid cached data.
 *
 * Queued-attachment stability: the attachment changes only from a server
 * attachment/report response (`refreshAttachment`, `refreshReportStatus`,
 * `queueReport`, `rehydrate`) — a session advance (action resync) re-reads it
 * from the server and never expands or rebuilds it locally.
 *
 * Races: every read/mutation-resync writes under a per-scope generation
 * counter. `rehydrate` mints the newest generation; late responses from an
 * older generation are discarded, and `setScope` invalidates the previous
 * scope so an obsolete in-flight rehydrate can neither overwrite the new
 * scope nor repopulate stale data into the old one.
 *
 * Idempotency: `submitAction` mints one `crypto.randomUUID()` per in-flight
 * action intent and JOINS concurrent same-intent calls onto a single in-flight
 * Promise (one HTTP call, one `requestId`); the join entry clears only when
 * the joined request settles, so a deliberate later action mints a fresh id.
 * `expectedRevision` always comes from the current server session — a missing
 * session rejects locally without calling the API.
 */

/** Action-intent input: the store owns the idempotency + CAS fields. */
export type ExperienceActionIntent = Omit<ExperienceActionRequest, "requestId" | "expectedRevision">;

export interface ExperienceScopeState {
  /** Chat experience config row (null = not loaded). */
  config: ExperienceChatConfigRow | null;
  /** Active branch session: metadata + projected human view (null = none). */
  session: ExperienceSessionResponse | null;
  /** Durable effect rows for the active session. */
  effects: ExperienceEffectRow[];
  /** Privacy-safe queued attachment (hidden checkpoint never present). */
  queuedAttachment: ExperienceQueuedAttachmentView | null;
  /** Server report status (report frontier + pending public-event count). */
  reportStatus: ExperienceReportStatus | null;
  /** Privacy-safe context-bundle metadata; loaded only with the `rp_context` grant. */
  contextStatus: ExperienceContextStatusDto | null;
  /** In-flight action intents: intentKey → requestId (cleared on settle). */
  actionRequestIds: Record<string, string>;
  loading: boolean;
  lastError: string | null;
  /** The structured API error behind `lastError` (status/code/details), when
   *  the failure came from the experience API — kept inspectable for stale-
   *  revision / capability-denied recovery logic. */
  lastApiError: ExperienceApiError | null;
  /** Local UI flag: the experience modal is open for this scope. Never
   *  authoritative — opening/closing it never touches session state. */
  modalOpen: boolean;
  /** Local UI flag: the experience view is detached into its own window. */
  detached: boolean;
}

interface ExperienceState {
  byScope: Record<string, ExperienceScopeState>;
  /** The scope the UI is currently showing — the refocus rehydration target. */
  activeScope: { chatId: string; branchId: string } | null;
}

export interface ExperienceActions {
  /** Record the active scope and rehydrate it (scope-change rehydration).
   *  Invalidates any obsolete in-flight work for the previous scope. */
  setScope: (chatId: string, branchId: string) => void;
  /** Reload config + branch session + session resources (refocus / resync). */
  rehydrate: (chatId: string, branchId: string) => Promise<void>;
  /** Reload only the branch's active session (404 `no_active_session` clears
   *  the session-owned resources without becoming an error). */
  refreshSession: (chatId: string, branchId: string) => Promise<void>;
  refreshEffects: (chatId: string, branchId: string) => Promise<void>;
  refreshAttachment: (chatId: string, branchId: string) => Promise<void>;
  refreshReportStatus: (chatId: string, branchId: string) => Promise<void>;
  /** Capability-safe: loads context status only when the current session
   *  grants `rp_context`; otherwise clears it without raising an error. */
  refreshContextStatus: (chatId: string, branchId: string) => Promise<void>;
  /** Start a session on the active scope's branch (config-driven setup). */
  startSession: (
    settings?: ExperienceStartRequest["settings"],
    participants?: ExperienceStartRequest["participants"],
  ) => Promise<ExperienceSessionResponse | null>;
  /** Explicit finish at the current server revision; the terminal attachment
   *  snapshot is returned to the caller (the post-end resync clears the
   *  now-inactive session resources). */
  endSession: () => Promise<ExperienceQueuedAttachmentResponse>;
  /** Submit one action intention against the active scope's session. The
   *  store supplies `requestId` + `expectedRevision`. Concurrent same-intent
   *  calls join one in-flight request. Rejects locally (no API call) when
   *  there is no active scope/session. Null return = server-side failure
   *  (see `lastError`/`lastApiError` after the resync). */
  submitAction: (intent: ExperienceActionIntent) => Promise<ExperienceActionResponse | null>;
  /** Run one pending model effect to a terminal state (abortable). */
  runEffect: (effectId: string, signal?: AbortSignal) => Promise<ExperienceEffectRunResponse | null>;
  /** Freeze a report attachment at the current server revision. The server
   *  response replaces the queued attachment. */
  queueReport: () => Promise<ExperienceQueuedAttachmentView | null>;
  /** Capture/replace the session's frozen RP-context bundle (abortable). */
  captureContext: (
    body: ExperienceContextCaptureRequest,
    signal?: AbortSignal,
  ) => Promise<ExperienceContextStatusDto | null>;
  /** Local-only UI controls — never mutate authoritative state. */
  openModal: () => void;
  closeModal: () => void;
  setDetached: (detached: boolean) => void;
}

function emptyScope(): ExperienceScopeState {
  return {
    config: null,
    session: null,
    effects: [],
    queuedAttachment: null,
    reportStatus: null,
    contextStatus: null,
    actionRequestIds: {},
    loading: false,
    lastError: null,
    lastApiError: null,
    modalOpen: false,
    detached: false,
  };
}

/** Collision-safe scope key: ids are only length-bounded strings (the bounded
 *  schema does not exclude `|`), so the pair is structurally encoded. */
function scopeKey(chatId: string, branchId: string): string {
  return JSON.stringify([chatId, branchId]);
}

/** Dedup key for one action intent (type + seat + payload). */
function actionIntentKey(intent: ExperienceActionIntent): string {
  return JSON.stringify([intent.type, intent.participantId ?? null, intent.payload ?? null]);
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeDraft(s: ExperienceState, key: string): ExperienceScopeState {
  return s.byScope[key] ?? (s.byScope[key] = emptyScope());
}

function isNoActiveSessionError(err: unknown): boolean {
  return err instanceof ExperienceApiError && err.status === 404 && err.code === "no_active_session";
}

function recordError(scope: ExperienceScopeState, err: unknown): void {
  scope.lastError = toMessage(err);
  scope.lastApiError = err instanceof ExperienceApiError ? err : null;
}

function clearError(scope: ExperienceScopeState): void {
  scope.lastError = null;
  scope.lastApiError = null;
}

/** Clear the resources owned by an active session (normal empty state after
 *  a 404 `no_active_session` discovery — not an error). */
function clearActiveSessionResources(scope: ExperienceScopeState): void {
  scope.session = null;
  scope.effects = [];
  scope.queuedAttachment = null;
  scope.reportStatus = null;
  scope.contextStatus = null;
}

// ── Race guards + in-flight join registry (module-level, per scope) ─────────

/** Async reads are guarded independently per resource so, for example, a
 *  focused effects refresh cannot cancel a full rehydrate and strand its
 *  loading flag. The scope epoch invalidates every resource when a scope is
 *  (re)activated; the resource generation keeps only the newest read of that
 *  field within the epoch. */
interface GenerationGuard {
  scopeEpoch: number;
  resourceGeneration: number;
}

const scopeEpochByScope: Record<string, number> = {};
const generationByResource = new Map<string, number>();
let activeScopeEpoch = 0;

function resourceKey(key: string, resource: string): string {
  return `${key}\n${resource}`;
}

function invalidateScope(key: string): void {
  scopeEpochByScope[key] = (scopeEpochByScope[key] ?? 0) + 1;
}

function beginGeneration(key: string, resource: string): GenerationGuard {
  const rKey = resourceKey(key, resource);
  const resourceGeneration = (generationByResource.get(rKey) ?? 0) + 1;
  generationByResource.set(rKey, resourceGeneration);
  return { scopeEpoch: scopeEpochByScope[key] ?? 0, resourceGeneration };
}

function isCurrentGeneration(key: string, resource: string, guard: GenerationGuard): boolean {
  return (
    (scopeEpochByScope[key] ?? 0) === guard.scopeEpoch
    && generationByResource.get(resourceKey(key, resource)) === guard.resourceGeneration
  );
}

/** In-flight action intents: joinKey (`scope\nintent`) → shared Promise. A
 *  concurrent same-intent call joins instead of issuing a duplicate HTTP
 *  call; the entry is deleted only when the joined request settles. */
const inFlightActionPromises = new Map<string, Promise<ExperienceActionResponse | null>>();

// Lazily registered (once) document listener: rehydrate the active scope when
// the tab regains visibility. Guarded so SSR/tests without a document skip it.
let visibilityListenerRegistered = false;
function ensureVisibilityListener(): void {
  if (visibilityListenerRegistered || typeof document === "undefined") return;
  visibilityListenerRegistered = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const scope = useExperienceStore.getState().activeScope;
    if (!scope) return;
    void useExperienceStore.getState().rehydrate(scope.chatId, scope.branchId);
  });
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

type SessionDiscovery =
  | { kind: "session"; session: ExperienceSessionResponse }
  | { kind: "none" }
  | { kind: "error"; error: unknown };

/** Branch-scoped active-session discovery: 404 `no_active_session` folds to
 *  the normal `none` outcome; any other failure stays an inspectable error. */
async function discoverSession(chatId: string, branchId: string): Promise<SessionDiscovery> {
  try {
    return { kind: "session", session: await getActiveExperienceSession(chatId, branchId) };
  } catch (error) {
    if (isNoActiveSessionError(error)) return { kind: "none" };
    return { kind: "error", error };
  }
}

export const useExperienceStore = create<ExperienceState & ExperienceActions>()(
  immer((set, get) => {
    /** Active scope or throw (mutation preconditions reject locally). */
    function requireActiveScope(): { chatId: string; branchId: string; key: string; activeEpoch: number } {
      const scope = get().activeScope;
      if (!scope) throw new Error("experience action requires an active scope (call setScope first)");
      return {
        chatId: scope.chatId,
        branchId: scope.branchId,
        key: scopeKey(scope.chatId, scope.branchId),
        activeEpoch: activeScopeEpoch,
      };
    }

    /** A mutation result belongs only to the scope activation that launched
     *  it. Switching A→B discards the late A result instead of starting a new
     *  rehydrate that would bypass A's invalidated read generations. */
    function isActiveOperation(key: string, epoch: number): boolean {
      const scope = get().activeScope;
      return (
        activeScopeEpoch === epoch
        && scope !== null
        && scopeKey(scope.chatId, scope.branchId) === key
      );
    }

    /** Current server session for a scope or throw — `expectedRevision` and
     *  the session id come only from this server-provided snapshot. */
    function requireSession(key: string): ExperienceSessionResponse {
      const session = get().byScope[key]?.session ?? null;
      if (!session) throw new Error("experience action requires an active session");
      return session;
    }

    /** Failure tail shared by every mutation: resync from the server FIRST
     *  (server wins), then surface the structured error. */
    async function failMutation(
      chatId: string,
      branchId: string,
      key: string,
      activeEpoch: number,
      err: unknown,
    ): Promise<null> {
      if (!isActiveOperation(key, activeEpoch)) return null;
      await get().rehydrate(chatId, branchId);
      if (!isActiveOperation(key, activeEpoch)) return null;
      set((s) => {
        recordError(scopeDraft(s, key), err);
      });
      return null;
    }

    return {
      byScope: {},
      activeScope: null,

      setScope: (chatId, branchId) => {
        const previous = get().activeScope;
        const nextKey = scopeKey(chatId, branchId);
        const previousKey = previous ? scopeKey(previous.chatId, previous.branchId) : null;
        if (previousKey !== nextKey) activeScopeEpoch += 1;
        if (previousKey) {
          // Invalidate every resource read launched by the previous scope
          // activation. Re-activating the same scope also supersedes its old
          // reads, while preserving mutations because the active key did not
          // change.
          invalidateScope(previousKey);
          set((s) => {
            const draft = s.byScope[previousKey];
            if (draft) draft.loading = false;
          });
        }
        if (previousKey !== nextKey) invalidateScope(nextKey);
        set((s) => {
          s.activeScope = { chatId, branchId };
        });
        ensureVisibilityListener();
        void get().rehydrate(chatId, branchId);
      },

      rehydrate: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const hydrationGeneration = beginGeneration(key, "rehydrate");
        const configGeneration = beginGeneration(key, "config");
        const sessionGeneration = beginGeneration(key, "session");
        set((s) => {
          scopeDraft(s, key).loading = true;
        });
        const errors: unknown[] = [];

        const [configResult, discovery] = await Promise.all([
          settle(getExperienceConfig(chatId)),
          discoverSession(chatId, branchId),
        ]);
        if (!isCurrentGeneration(key, "rehydrate", hydrationGeneration)) return;
        const configIsCurrent = isCurrentGeneration(key, "config", configGeneration);
        const sessionIsCurrent = isCurrentGeneration(key, "session", sessionGeneration);
        set((s) => {
          const scope = scopeDraft(s, key);
          if (configIsCurrent && configResult.ok) scope.config = configResult.value;
          if (sessionIsCurrent && discovery.kind === "session") scope.session = discovery.session;
          else if (sessionIsCurrent && discovery.kind === "none") clearActiveSessionResources(scope);
          // Discovery error: keep the cached session — never erase valid data.
        });
        if (configIsCurrent && !configResult.ok) errors.push(configResult.error);
        if (sessionIsCurrent && discovery.kind === "error") errors.push(discovery.error);

        // A newer focused session refresh supersedes this discovery. Do not
        // load resources for its now-obsolete session snapshot.
        if (sessionIsCurrent && discovery.kind === "session") {
          const session = discovery.session;
          const grantsContext = session.capabilityGrants.includes("rp_context");
          const effectsGeneration = beginGeneration(key, "effects");
          const attachmentGeneration = beginGeneration(key, "attachment");
          const reportGeneration = beginGeneration(key, "report");
          const contextGeneration = beginGeneration(key, "context");
          const [effectsResult, attachmentResult, reportResult, contextResult] = await Promise.all([
            settle(getExperienceEffects(session.sessionId)),
            settle(getExperienceQueuedAttachment(session.sessionId)),
            settle(getExperienceReportStatus(session.sessionId)),
            grantsContext
              ? settle(getExperienceContextStatus(session.sessionId))
              : Promise.resolve(null),
          ]);
          if (!isCurrentGeneration(key, "rehydrate", hydrationGeneration)) return;
          const effectsIsCurrent = isCurrentGeneration(key, "effects", effectsGeneration);
          const attachmentIsCurrent = isCurrentGeneration(key, "attachment", attachmentGeneration);
          const reportIsCurrent = isCurrentGeneration(key, "report", reportGeneration);
          const contextIsCurrent = isCurrentGeneration(key, "context", contextGeneration);
          set((s) => {
            const scope = scopeDraft(s, key);
            if (effectsIsCurrent && effectsResult.ok) scope.effects = effectsResult.value;
            if (reportIsCurrent && reportResult.ok) scope.reportStatus = reportResult.value;
            if (attachmentIsCurrent) {
              // Both reads carry the current queued attachment. A successful
              // report status is the richer/later authority; otherwise retain
              // a successful direct attachment read.
              if (reportResult.ok) scope.queuedAttachment = reportResult.value.queuedAttachment;
              else if (attachmentResult.ok) scope.queuedAttachment = attachmentResult.value;
            }
            if (contextIsCurrent) {
              if (contextResult === null) scope.contextStatus = null;
              else if (contextResult.ok) scope.contextStatus = contextResult.value;
            }
          });
          if (effectsIsCurrent && !effectsResult.ok) errors.push(effectsResult.error);
          if (attachmentIsCurrent && !attachmentResult.ok) errors.push(attachmentResult.error);
          if (reportIsCurrent && !reportResult.ok) errors.push(reportResult.error);
          if (contextIsCurrent && contextResult !== null && !contextResult.ok) errors.push(contextResult.error);
        }

        if (!isCurrentGeneration(key, "rehydrate", hydrationGeneration)) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          scope.loading = false;
          const first = errors[0];
          if (first === undefined) clearError(scope);
          else recordError(scope, first);
        });
      },

      refreshSession: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const generation = beginGeneration(key, "session");
        const discovery = await discoverSession(chatId, branchId);
        if (!isCurrentGeneration(key, "session", generation)) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          if (discovery.kind === "session") {
            scope.session = discovery.session;
            clearError(scope);
          } else if (discovery.kind === "none") {
            clearActiveSessionResources(scope);
            clearError(scope);
          } else {
            recordError(scope, discovery.error);
          }
        });
      },

      refreshEffects: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const generation = beginGeneration(key, "effects");
        const session = get().byScope[key]?.session ?? null;
        if (!session) {
          set((s) => {
            scopeDraft(s, key).effects = [];
          });
          return;
        }
        const result = await settle(getExperienceEffects(session.sessionId));
        if (!isCurrentGeneration(key, "effects", generation)) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          if (result.ok) {
            scope.effects = result.value;
            clearError(scope);
          } else {
            recordError(scope, result.error);
          }
        });
      },

      refreshAttachment: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const generation = beginGeneration(key, "attachment");
        const session = get().byScope[key]?.session ?? null;
        if (!session) {
          set((s) => {
            scopeDraft(s, key).queuedAttachment = null;
          });
          return;
        }
        const result = await settle(getExperienceQueuedAttachment(session.sessionId));
        if (!isCurrentGeneration(key, "attachment", generation)) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          if (result.ok) {
            scope.queuedAttachment = result.value;
            clearError(scope);
          } else {
            recordError(scope, result.error);
          }
        });
      },

      refreshReportStatus: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const reportGeneration = beginGeneration(key, "report");
        const attachmentGeneration = beginGeneration(key, "attachment");
        const session = get().byScope[key]?.session ?? null;
        if (!session) {
          set((s) => {
            const scope = scopeDraft(s, key);
            scope.reportStatus = null;
            scope.queuedAttachment = null;
          });
          return;
        }
        const result = await settle(getExperienceReportStatus(session.sessionId));
        const reportIsCurrent = isCurrentGeneration(key, "report", reportGeneration);
        const attachmentIsCurrent = isCurrentGeneration(key, "attachment", attachmentGeneration);
        if (!reportIsCurrent && !attachmentIsCurrent) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          if (result.ok) {
            if (reportIsCurrent) scope.reportStatus = result.value;
            if (attachmentIsCurrent) scope.queuedAttachment = result.value.queuedAttachment;
            clearError(scope);
          } else {
            recordError(scope, result.error);
          }
        });
      },

      refreshContextStatus: async (chatId, branchId) => {
        const key = scopeKey(chatId, branchId);
        const generation = beginGeneration(key, "context");
        const session = get().byScope[key]?.session ?? null;
        if (!session || !session.capabilityGrants.includes("rp_context")) {
          // Expected capability absence (or no session) is the normal
          // empty state — never a store error.
          set((s) => {
            scopeDraft(s, key).contextStatus = null;
          });
          return;
        }
        const result = await settle(getExperienceContextStatus(session.sessionId));
        if (!isCurrentGeneration(key, "context", generation)) return;
        set((s) => {
          const scope = scopeDraft(s, key);
          if (result.ok) {
            scope.contextStatus = result.value;
            clearError(scope);
          } else {
            recordError(scope, result.error);
          }
        });
      },

      startSession: async (settings, participants) => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        set((s) => {
          clearError(scopeDraft(s, key));
        });
        try {
          const response = await startExperienceSession(chatId, { branchId, settings, participants });
          if (isActiveOperation(key, activeEpoch)) await get().rehydrate(chatId, branchId);
          return response;
        } catch (err) {
          return failMutation(chatId, branchId, key, activeEpoch, err);
        }
      },

      endSession: async () => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        const session = requireSession(key);
        set((s) => {
          clearError(scopeDraft(s, key));
        });
        try {
          const response = await endExperienceSession(session.sessionId, {
            expectedRevision: session.revision,
          });
          // Resync: discovery now answers no_active_session, clearing the
          // session-owned resources (server wins).
          if (isActiveOperation(key, activeEpoch)) await get().rehydrate(chatId, branchId);
          return response;
        } catch (err) {
          return failMutation(chatId, branchId, key, activeEpoch, err);
        }
      },

      submitAction: async (intent) => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        const session = requireSession(key);
        const intentId = actionIntentKey(intent);
        const joinKey = `${key}\n${intentId}`;
        const existing = inFlightActionPromises.get(joinKey);
        if (existing) return existing;
        const requestId = crypto.randomUUID();
        const expectedRevision = session.revision;
        set((s) => {
          const scope = scopeDraft(s, key);
          scope.actionRequestIds[intentId] = requestId;
          clearError(scope);
        });
        const promise = (async (): Promise<ExperienceActionResponse | null> => {
          try {
            const response = await submitExperienceAction(
              session.sessionId,
              { ...intent, requestId, expectedRevision },
            );
            if (isActiveOperation(key, activeEpoch)) await get().rehydrate(chatId, branchId);
            return response;
          } catch (err) {
            return failMutation(chatId, branchId, key, activeEpoch, err);
          } finally {
            inFlightActionPromises.delete(joinKey);
            set((s) => {
              delete scopeDraft(s, key).actionRequestIds[intentId];
            });
          }
        })();
        inFlightActionPromises.set(joinKey, promise);
        return promise;
      },

      runEffect: async (effectId, signal) => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        set((s) => {
          clearError(scopeDraft(s, key));
        });
        try {
          const response = await runExperienceEffect(effectId, { signal });
          if (isActiveOperation(key, activeEpoch)) await get().rehydrate(chatId, branchId);
          return response;
        } catch (err) {
          return failMutation(chatId, branchId, key, activeEpoch, err);
        }
      },

      queueReport: async () => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        const session = requireSession(key);
        set((s) => {
          clearError(scopeDraft(s, key));
        });
        try {
          const response = await queueExperienceReport(session.sessionId, {
            expectedRevision: session.revision,
          });
          if (isActiveOperation(key, activeEpoch)) {
            // A server report response may replace the queued attachment.
            set((s) => {
              scopeDraft(s, key).queuedAttachment = response;
            });
            await get().rehydrate(chatId, branchId);
          }
          return response;
        } catch (err) {
          return failMutation(chatId, branchId, key, activeEpoch, err);
        }
      },

      captureContext: async (body, signal) => {
        const { chatId, branchId, key, activeEpoch } = requireActiveScope();
        const session = requireSession(key);
        set((s) => {
          clearError(scopeDraft(s, key));
        });
        try {
          const response = await captureExperienceContext(session.sessionId, body, { signal });
          if (isActiveOperation(key, activeEpoch)) {
            set((s) => {
              scopeDraft(s, key).contextStatus = response;
            });
            await get().rehydrate(chatId, branchId);
          }
          return response;
        } catch (err) {
          return failMutation(chatId, branchId, key, activeEpoch, err);
        }
      },

      openModal: () => {
        const scope = get().activeScope;
        if (!scope) return;
        set((s) => {
          scopeDraft(s, scopeKey(scope.chatId, scope.branchId)).modalOpen = true;
        });
      },

      closeModal: () => {
        const scope = get().activeScope;
        if (!scope) return;
        set((s) => {
          scopeDraft(s, scopeKey(scope.chatId, scope.branchId)).modalOpen = false;
        });
      },

      setDetached: (detached) => {
        const scope = get().activeScope;
        if (!scope) return;
        set((s) => {
          scopeDraft(s, scopeKey(scope.chatId, scope.branchId)).detached = detached;
        });
      },
    };
  }),
);

/**
 * Test-only reset: clears the store state plus the module-level generation
 * and in-flight-join registries so tests never depend on execution order.
 * Also re-arms the one-time visibility-listener registration; that is safe in
 * tests because each test installs its own fake `document` (or none at all).
 * Never call from application code — a real already-registered DOM listener
 * is NOT removed by this.
 */
export function resetExperienceStoreForTests(): void {
  useExperienceStore.setState({ byScope: {}, activeScope: null });
  for (const key of Object.keys(scopeEpochByScope)) {
    delete scopeEpochByScope[key];
  }
  generationByResource.clear();
  activeScopeEpoch = 0;
  inFlightActionPromises.clear();
  visibilityListenerRegistered = false;
}

// ── Narrow selectors ─────────────────────────────────────────────────────
// Each projects one field of one scope so unrelated scope/field changes do not
// re-render a subscriber.

const EMPTY_SCOPE = emptyScope();

function selectScope(
  s: ExperienceState,
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceScopeState {
  if (!chatId || !branchId) return EMPTY_SCOPE;
  return s.byScope[scopeKey(chatId, branchId)] ?? EMPTY_SCOPE;
}

/** Chat experience config row for the scope (null while unloaded). */
export function useExperienceConfig(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceChatConfigRow | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).config));
}

/** Active branch session (metadata + projected view) for the scope. */
export function useExperienceSession(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceSessionResponse | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).session));
}

/** Durable effect rows for the scope's active session. */
export function useExperienceEffects(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceEffectRow[] {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).effects));
}

/** Privacy-safe queued attachment for the scope (null when none is queued). */
export function useExperienceQueuedAttachment(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceQueuedAttachmentView | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).queuedAttachment));
}

/** Server report status for the scope (null while unloaded / no session). */
export function useExperienceReportStatus(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceReportStatus | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).reportStatus));
}

/** Privacy-safe context status for the scope (null without the grant / capture). */
export function useExperienceContextStatus(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): ExperienceContextStatusDto | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).contextStatus));
}

/** The scope's last error message (null when clean). */
export function useExperienceLastError(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): string | null {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).lastError));
}

/** Whether the scope is currently rehydrating. */
export function useExperienceLoading(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): boolean {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).loading));
}

/** Local UI flag: the experience modal is open for the scope. */
export function useExperienceModalOpen(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): boolean {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).modalOpen));
}

/** Local UI flag: the experience view is detached for the scope. */
export function useExperienceDetached(
  chatId: string | null | undefined,
  branchId: string | null | undefined,
): boolean {
  return useExperienceStore(useShallow((s) => selectScope(s, chatId, branchId).detached));
}
