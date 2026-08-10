/**
 * Experience API client (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 / IR-71A).
 *
 * Thin Hono-RPC client for every mounted endpoint in
 * `services/api/src/api/routes/experience.ts`, mirroring the `dice-api.ts`
 * pattern. The client is server-authoritative: it submits only identifiers,
 * bounded settings, participant rosters, and action intentions carrying
 * `requestId` + `expectedRevision` — never authoritative state, events, or
 * transitions; the server reduces and projects.
 *
 * Endpoint groups (all typed via `client.api.*`, no raw fetch):
 *   config    — GET/PUT  /api/chats/:chatId/experience/config
 *   visuals   — CRUD under /api/experience/visuals
 *   sessions  — start under the chat; branch discovery, get, end, actions,
 *               view, attachment, reports, undo, recalculate, effects,
 *               context, and prompt overrides under /api/experience/…
 */
import { client } from "./client.js";
import type { RpcResponse } from "./unwrap.js";
import type {
  ExperienceActionDescriptor,
  ExperienceActionRequest,
  ExperienceActionResponse,
  ExperienceChatConfigRow,
  ExperienceConfigUpdateRequest,
  ExperienceContextCaptureRequest,
  ExperienceContextStatusDto,
  ExperienceEffectRow,
  ExperienceEffectRunResponse,
  ExperienceFinishRequest,
  ExperienceProjection,
  ExperiencePromptOverrideContentRequest,
  ExperiencePromptOverridesResponse,
  ExperienceQueuedAttachmentResponse,
  ExperienceQueuedAttachmentView,
  ExperienceRecalculateRequest,
  ExperienceRecalculationPreview,
  ExperienceReportQueueRequest,
  ExperienceReportStatus,
  ExperienceSessionResponse,
  ExperienceStartRequest,
  ExperienceTestRunData,
  ExperienceTestRunRequest,
  ExperienceTestSimulateData,
  ExperienceTestSimulateRequest,
  ExperienceUndoRequest,
  ExperienceVisualCreateRequest,
  ExperienceVisualRow,
  ExperienceVisualsQuery,
  ExperienceVisualUpdateRequest,
} from "./types.js";

/**
 * Structured Experience API error. The shared `unwrapError` collapses the
 * backend's `{ error: { kind, message, details } }` body into a plain `Error`,
 * discarding `details.code` — which the experience store needs to distinguish
 * `409 stale_revision` / `409 branch_has_active` / `422 capability_denied`
 * from other failures (Wave 7 store conflict handling). This preserves the
 * HTTP status, the structured code, and the full details record
 * (`currentRevision`, `granted`/`needs`, `failedActionIndex`, …) without
 * touching the shared helper. Mirrors {@link DiceApiError}'s rationale.
 */
export class ExperienceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ExperienceApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Centralized unwrap: success → typed JSON; failure → {@link ExperienceApiError}
 *  preserving status + `details.code` + the full details record. A non-JSON or
 *  non-standard error body still yields an `ExperienceApiError` with a fallback
 *  message — an experience failure never collapses to a plain `Error`. */
async function unwrapExperience<T>(response: RpcResponse): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as
    | { error?: string | { message?: string; details?: Record<string, unknown> & { code?: string } } }
    | null;
  const err = body?.error;
  const message = typeof err === "string" ? err : err?.message ?? `Request failed: ${response.status}`;
  const details = typeof err === "object" && err !== null ? err.details : undefined;
  throw new ExperienceApiError(response.status, message, details?.code, details);
}

// ─── Config ──────────────────────────────────────────────────────────────────

/** GET /api/chats/:chatId/experience/config — the chat's experience config row
 *  (the config-driven setup source; lazily created server-side). */
export async function getExperienceConfig(chatId: string): Promise<ExperienceChatConfigRow> {
  const response = await client.api.chats[":chatId"].experience.config.$get({ param: { chatId } });
  return unwrapExperience<ExperienceChatConfigRow>(response);
}

/** PUT /api/chats/:chatId/experience/config — partial patch; returns the row. */
export async function updateExperienceConfig(
  chatId: string,
  body: ExperienceConfigUpdateRequest,
): Promise<ExperienceChatConfigRow> {
  const response = await client.api.chats[":chatId"].experience.config.$put({ param: { chatId }, json: body });
  return unwrapExperience<ExperienceChatConfigRow>(response);
}

// ─── Visual resources ────────────────────────────────────────────────────────

/** GET /api/experience/visuals — list visuals by scope (+ optional owner). */
export async function listExperienceVisuals(query: ExperienceVisualsQuery): Promise<ExperienceVisualRow[]> {
  const response = await client.api.experience.visuals.$get({ query });
  return unwrapExperience<ExperienceVisualRow[]>(response);
}

/** GET /api/experience/visuals/:id — one visual, or null when missing. */
export async function getExperienceVisual(id: string): Promise<ExperienceVisualRow | null> {
  const response = await client.api.experience.visuals[":id"].$get({ param: { id } });
  return unwrapExperience<ExperienceVisualRow | null>(response);
}

/** POST /api/experience/visuals — create a visual resource. */
export async function createExperienceVisual(body: ExperienceVisualCreateRequest): Promise<ExperienceVisualRow> {
  const response = await client.api.experience.visuals.$post({ json: body });
  return unwrapExperience<ExperienceVisualRow>(response);
}

/** PATCH /api/experience/visuals/:id — patch a visual (a source edit changes
 *  the sourceHash trust signal server-side). */
export async function updateExperienceVisual(
  id: string,
  body: ExperienceVisualUpdateRequest,
): Promise<ExperienceVisualRow> {
  const response = await client.api.experience.visuals[":id"].$patch({ param: { id }, json: body });
  return unwrapExperience<ExperienceVisualRow>(response);
}

/** DELETE /api/experience/visuals/:id — remove a visual (active sessions pin
 *  an immutable source snapshot, so they are unaffected). */
export async function deleteExperienceVisual(id: string): Promise<void> {
  const response = await client.api.experience.visuals[":id"].$delete({ param: { id } });
  await unwrapExperience<unknown>(response);
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/** POST /api/chats/:chatId/experience/sessions — start a branch-scoped session
 *  (config-driven: rules script, visual, capability grants, and context mode
 *  resolve server-side from the chat config). */
export async function startExperienceSession(
  chatId: string,
  body: ExperienceStartRequest,
): Promise<ExperienceSessionResponse> {
  const response = await client.api.chats[":chatId"].experience.sessions.$post({ param: { chatId }, json: body });
  return unwrapExperience<ExperienceSessionResponse>(response);
}

/** GET /api/chats/:chatId/experience/session?branchId=… — branch-scoped
 *  active-session discovery (IR-70A). `branchId` is strictly required. */
export async function getActiveExperienceSession(chatId: string, branchId: string): Promise<ExperienceSessionResponse> {
  const response = await client.api.chats[":chatId"].experience.session.$get({
    param: { chatId },
    query: { branchId },
  });
  return unwrapExperience<ExperienceSessionResponse>(response);
}

/** GET /api/experience/sessions/:sessionId — session metadata + the projected
 *  view for the human viewer. */
export async function getExperienceSession(sessionId: string): Promise<ExperienceSessionResponse> {
  const response = await client.api.experience.sessions[":sessionId"].$get({ param: { sessionId } });
  return unwrapExperience<ExperienceSessionResponse>(response);
}

/** POST /api/experience/sessions/:sessionId/end — canonical explicit user
 *  finish (host-owned `interrupted`); the terminal snapshot is atomically
 *  queued and returned through the privacy-safe attachment DTO. */
export async function endExperienceSession(
  sessionId: string,
  body: ExperienceFinishRequest,
): Promise<ExperienceQueuedAttachmentResponse> {
  const response = await client.api.experience.sessions[":sessionId"].end.$post({ param: { sessionId }, json: body });
  return unwrapExperience<ExperienceQueuedAttachmentResponse>(response);
}

/** POST /api/experience/sessions/:sessionId/actions — submit one action
 *  intention (idempotency + CAS via `requestId`/`expectedRevision`); the
 *  server auto-resolves any script seats before returning. Abortable: the
 *  signal is forwarded through the Hono RPC request init. */
export async function submitExperienceAction(
  sessionId: string,
  body: ExperienceActionRequest,
  options?: { signal?: AbortSignal },
): Promise<ExperienceActionResponse> {
  const response = await client.api.experience.sessions[":sessionId"].actions.$post(
    { param: { sessionId }, json: body },
    { init: { signal: options?.signal } },
  );
  return unwrapExperience<ExperienceActionResponse>(response);
}

// ─── Per-viewer projection reads ─────────────────────────────────────────────

/** GET /api/experience/sessions/:sessionId/view — projected view for one
 *  viewer (defaults to the human seat when `participantId` is omitted). */
export async function getExperienceView(sessionId: string, participantId?: string): Promise<ExperienceProjection> {
  const response = await client.api.experience.sessions[":sessionId"].view.$get({
    param: { sessionId },
    query: { participantId },
  });
  return unwrapExperience<ExperienceProjection>(response);
}

/** GET /api/experience/sessions/:sessionId/actions — legal action descriptors
 *  for one viewer (defaults to the human seat). */
export async function getExperienceActions(
  sessionId: string,
  participantId?: string,
): Promise<ExperienceActionDescriptor[]> {
  const response = await client.api.experience.sessions[":sessionId"].actions.$get({
    param: { sessionId },
    query: { participantId },
  });
  return unwrapExperience<ExperienceActionDescriptor[]>(response);
}

// ─── Queued attachment + reports (IR-70A) ────────────────────────────────────

/** GET /api/experience/sessions/:sessionId/attachment — the session's current
 *  queued attachment through the privacy-safe DTO (never the hidden
 *  checkpoint), or null when none is queued. */
export async function getExperienceQueuedAttachment(sessionId: string): Promise<ExperienceQueuedAttachmentResponse> {
  const response = await client.api.experience.sessions[":sessionId"].attachment.$get({ param: { sessionId } });
  return unwrapExperience<ExperienceQueuedAttachmentResponse>(response);
}

/** POST /api/experience/sessions/:sessionId/reports/queue — explicit Queue /
 *  Add-later report freeze at the exact pinned revision. */
export async function queueExperienceReport(
  sessionId: string,
  body: ExperienceReportQueueRequest,
): Promise<ExperienceQueuedAttachmentView> {
  const response = await client.api.experience.sessions[":sessionId"].reports.queue.$post({
    param: { sessionId },
    json: body,
  });
  return unwrapExperience<ExperienceQueuedAttachmentView>(response);
}

/** GET /api/experience/sessions/:sessionId/reports/status — privacy-safe
 *  server report status + validated-public-event count. */
export async function getExperienceReportStatus(sessionId: string): Promise<ExperienceReportStatus> {
  const response = await client.api.experience.sessions[":sessionId"].reports.status.$get({ param: { sessionId } });
  return unwrapExperience<ExperienceReportStatus>(response);
}

// ─── Replay ──────────────────────────────────────────────────────────────────

/** POST /api/experience/sessions/:sessionId/undo — undo to a prior revision
 *  (append-only: creates a new system revision). */
export async function undoExperienceSession(
  sessionId: string,
  body: ExperienceUndoRequest,
): Promise<ExperienceActionResponse> {
  const response = await client.api.experience.sessions[":sessionId"].undo.$post({ param: { sessionId }, json: body });
  return unwrapExperience<ExperienceActionResponse>(response);
}

/** POST /api/experience/sessions/:sessionId/recalculate — preview a
 *  recalculation under candidate rules source (safe: no commit). */
export async function previewExperienceRecalculation(
  sessionId: string,
  body: ExperienceRecalculateRequest,
): Promise<ExperienceRecalculationPreview> {
  const response = await client.api.experience.sessions[":sessionId"].recalculate.$post({
    param: { sessionId },
    json: body,
  });
  return unwrapExperience<ExperienceRecalculationPreview>(response);
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/** GET /api/experience/sessions/:sessionId/effects — the session's durable
 *  effect rows (read-only). */
export async function getExperienceEffects(sessionId: string): Promise<ExperienceEffectRow[]> {
  const response = await client.api.experience.sessions[":sessionId"].effects.$get({ param: { sessionId } });
  return unwrapExperience<ExperienceEffectRow[]>(response);
}

/** POST /api/experience/effects/:effectId/run — run one pending model effect
 *  to a terminal state and feed the result back into the reducer. Abortable:
 *  client disconnect maps to the durable `cancelled` interruption policy. */
export async function runExperienceEffect(
  effectId: string,
  options?: { signal?: AbortSignal },
): Promise<ExperienceEffectRunResponse> {
  const response = await client.api.experience.effects[":effectId"].run.$post(
    { param: { effectId } },
    { init: { signal: options?.signal } },
  );
  return unwrapExperience<ExperienceEffectRunResponse>(response);
}

// ─── Context capture + status (IR-70D) ───────────────────────────────────────

/** POST /api/experience/sessions/:sessionId/context/capture — explicit
 *  cancellable context-bundle capture. Abortable: a disconnect cancels the
 *  compact-summary generation and preserves the previous bundle. */
export async function captureExperienceContext(
  sessionId: string,
  body: ExperienceContextCaptureRequest,
  options?: { signal?: AbortSignal },
): Promise<ExperienceContextStatusDto> {
  const response = await client.api.experience.sessions[":sessionId"].context.capture.$post(
    { param: { sessionId }, json: body },
    { init: { signal: options?.signal } },
  );
  return unwrapExperience<ExperienceContextStatusDto>(response);
}

/** GET /api/experience/sessions/:sessionId/context/status — privacy-safe
 *  context-bundle metadata (session metadata + provider/model ids only, with
 *  the IR-70D `branchFrontierRevision`), or null when never captured. */
export async function getExperienceContextStatus(sessionId: string): Promise<ExperienceContextStatusDto | null> {
  const response = await client.api.experience.sessions[":sessionId"].context.status.$get({ param: { sessionId } });
  return unwrapExperience<ExperienceContextStatusDto | null>(response);
}

// ─── Prompt overrides (IR-70D) ───────────────────────────────────────────────

/** GET /api/experience/sessions/:sessionId/prompt-overrides — both independent
 *  layers (global + current-character); never collapses to the effective
 *  winner only. */
export async function getExperiencePromptOverrides(sessionId: string): Promise<ExperiencePromptOverridesResponse> {
  const response = await client.api.experience.sessions[":sessionId"]["prompt-overrides"].$get({
    param: { sessionId },
  });
  return unwrapExperience<ExperiencePromptOverridesResponse>(response);
}

/** PUT /api/experience/sessions/:sessionId/prompt-overrides/global — write the
 *  global layer; returns the updated combined layers. */
export async function updateExperienceGlobalOverride(
  sessionId: string,
  body: ExperiencePromptOverrideContentRequest,
): Promise<ExperiencePromptOverridesResponse> {
  const response = await client.api.experience.sessions[":sessionId"]["prompt-overrides"].global.$put({
    param: { sessionId },
    json: body,
  });
  return unwrapExperience<ExperiencePromptOverridesResponse>(response);
}

/** PUT /api/experience/sessions/:sessionId/prompt-overrides/character — write
 *  the current-character layer (the character is derived session → chat
 *  server-side; never accepted from the client). Returns the updated combined
 *  layers. */
export async function updateExperienceCharacterOverride(
  sessionId: string,
  body: ExperiencePromptOverrideContentRequest,
): Promise<ExperiencePromptOverridesResponse> {
  const response = await client.api.experience.sessions[":sessionId"]["prompt-overrides"].character.$put({
    param: { sessionId },
    json: body,
  });
  return unwrapExperience<ExperiencePromptOverridesResponse>(response);
}

// ─── Stateless unsaved-source tester (Wave 8 / IR-81B backend, IR-81D client) ─

/** POST /api/experience/test/run — drive UNSAVED rules source through the real
 *  sandbox/kernel with zero persistence: discover + create + project + legal
 *  actions, then replay the ordered `actions` list (host-managed revision,
 *  requestId idempotency, expectedRevision CAS). Typed tester failures surface
 *  as {@link ExperienceApiError} with `details.code` (illegal_action,
 *  stale_revision + currentRevision, capability_denied + granted/needs,
 *  vm_error + kind) and the captured console in `details.console`. */
export async function runExperienceTest(body: ExperienceTestRunRequest): Promise<ExperienceTestRunData> {
  const response = await client.api.experience.test.run.$post({ json: body });
  return unwrapExperience<ExperienceTestRunData>(response);
}

/** POST /api/experience/test/simulate — discover + create, then run a bounded
 *  automated simulation advancing script-controlled seats via the real
 *  `choose` until a human/model boundary, a terminal status, no legal action,
 *  or a host bound; the typed stop reason is returned as data. */
export async function simulateExperienceTest(body: ExperienceTestSimulateRequest): Promise<ExperienceTestSimulateData> {
  const response = await client.api.experience.test.simulate.$post({ json: body });
  return unwrapExperience<ExperienceTestSimulateData>(response);
}
