/**
 * Normalizers for the chat row's freeform JSON columns
 * (`auto_summary_config_json`, `insights_config_json`,
 * `insights_objective_state_json`).
 *
 * The columns carry no DB-level shape: rows written before a field existed miss
 * it, and a corrupt value must never crash a read. The chat store runs every
 * column through these once, on read, so services and the wire DTO receive
 * complete typed values and never re-guard the raw JSON. Request-body
 * validation stays in the api-contracts zod schemas; these only repair stored
 * data and therefore never throw.
 */
import type { AutoSummaryConfig, InsightsConfig, ObjectiveLongTermGoal, ObjectiveState, ObjectiveTask } from "./entities.js";
import {
  DICE_ACTOR_TYPE,
  DICE_MODE,
  OBJECTIVE_MODE,
  OBJECTIVE_TASK_STATUS,
  type DiceActorType,
  type ObjectiveTaskStatus,
} from "./platform-constants.js";
import { normalizeSceneTrackerConfig } from "./scene-tracker-constants.js";

/** Default recent-message window for the Objective model. */
export const OBJECTIVE_CONTEXT_WINDOW = 5;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `Math.floor` of a finite stored number clamped to `min`, else `fallback`. */
function flooredAtLeast(value: unknown, min: number, fallback: number): number {
  const n = finiteNumber(value);
  return n === null ? fallback : Math.max(min, Math.floor(n));
}

// ─── Auto-summary ─────────────────────────────────────────────────────────────

export function normalizeAutoSummaryConfig(raw: unknown): AutoSummaryConfig {
  const r = isPlainRecord(raw) ? raw : {};
  const maxPriorSummaries = finiteNumber(r.maxPriorSummaries);
  return {
    enabled: r.enabled === true,
    everyN: flooredAtLeast(r.everyN, 1, 20),
    useChatModel: r.useChatModel !== false,
    excludeSummarized: r.excludeSummarized !== false,
    // SUMMARY_PRIOR_CONTEXT_PLAN (SPC-3): default ON + 10 most-recent priors.
    includePriorSummaries: r.includePriorSummaries !== false,
    maxPriorSummaries: maxPriorSummaries === null ? 10 : Math.max(0, Math.min(100, Math.floor(maxPriorSummaries))),
    ...(typeof r.providerProfileId === "string" ? { providerProfileId: r.providerProfileId } : {}),
    ...(typeof r.model === "string" ? { model: r.model } : {}),
  };
}

// ─── Insights toggles ─────────────────────────────────────────────────────────

function isDiceActorType(value: unknown): value is DiceActorType {
  return value === DICE_ACTOR_TYPE.persona || value === DICE_ACTOR_TYPE.character;
}

/** Non-record → `null` (no override). Entries that are not arrays or keep no
 *  valid actor are dropped: an empty binding falls back to declared actors. */
function normalizeDiceActorBindings(raw: unknown): Record<string, DiceActorType[]> | null {
  if (!isPlainRecord(raw)) return null;
  const out: Record<string, DiceActorType[]> = {};
  for (const [scriptId, actors] of Object.entries(raw)) {
    if (scriptId.length === 0 || !Array.isArray(actors)) continue;
    const valid = actors.filter(isDiceActorType);
    if (valid.length > 0) out[scriptId] = valid;
  }
  return out;
}

export function normalizeInsightsConfig(raw: unknown): InsightsConfig {
  const r = isPlainRecord(raw) ? raw : {};
  return {
    objectiveEnabled: r.objectiveEnabled === true,
    trackerEnabled: r.trackerEnabled === true,
    diceEnabled: r.diceEnabled === true,
    diceMode: r.diceMode === DICE_MODE.immersive ? DICE_MODE.immersive : DICE_MODE.normal,
    // An array is the explicit chat-local set; anything else inherits.
    diceScriptIds: Array.isArray(r.diceScriptIds)
      ? r.diceScriptIds.filter((id): id is string => typeof id === "string")
      : null,
    diceActorBindings: normalizeDiceActorBindings(r.diceActorBindings),
    // Stays absent until the Scene Tracker is first configured, so stored rows
    // never materialize tracker defaults on an unrelated write.
    ...(isPlainRecord(r.tracker) ? { tracker: normalizeSceneTrackerConfig(r.tracker) } : {}),
  };
}

// ─── Objective state ──────────────────────────────────────────────────────────

/** Default ObjectiveState for a chat that has none yet. */
export function defaultObjectiveState(): ObjectiveState {
  return {
    mode: OBJECTIVE_MODE.route,
    objectiveDescription: "",
    tasks: [],
    longTermGoal: null,
    shortTermGoals: [],
    autoCheckFrequency: 0,
    autoCheckEventCount: 0,
    contextWindow: OBJECTIVE_CONTEXT_WINDOW,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
    useChatModel: true,
    providerProfileId: null,
    model: null,
  };
}

export function isObjectiveTaskStatus(value: unknown): value is ObjectiveTaskStatus {
  return Object.values(OBJECTIVE_TASK_STATUS).some((status) => status === value);
}

/**
 * Route tasks OR goals-mode short-term goals (identical item shape): drop items
 * without an id, a non-blank description, or a known status, and collapse to at
 * most one `active` (later claimants fall back to `pending`).
 */
function normalizeObjectiveItems(raw: unknown): ObjectiveTask[] {
  if (!Array.isArray(raw)) return [];
  const items: ObjectiveTask[] = [];
  let activeSeen = false;
  for (const candidate of raw) {
    if (!isPlainRecord(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
    const status = candidate.status;
    if (!id || !description || !isObjectiveTaskStatus(status)) continue;
    const effective = status === OBJECTIVE_TASK_STATUS.active && activeSeen ? OBJECTIVE_TASK_STATUS.pending : status;
    if (effective === OBJECTIVE_TASK_STATUS.active) activeSeen = true;
    items.push({ id, description, status: effective });
  }
  return items;
}

function normalizeLongTermGoal(raw: unknown): ObjectiveLongTermGoal | null {
  if (!isPlainRecord(raw)) return null;
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description || !isObjectiveTaskStatus(raw.status)) return null;
  return { description, status: raw.status };
}

function nonBlankStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Complete ObjectiveState from a stored value, filling every missing or invalid
 * field with its default. Chats stored as `{}` or before the model-selection
 * fields existed load with `useChatModel: true`, so auto-check keeps working
 * without a DB migration.
 */
export function normalizeObjectiveState(raw: unknown): ObjectiveState {
  const base = defaultObjectiveState();
  if (!isPlainRecord(raw)) return base;
  return {
    mode: raw.mode === OBJECTIVE_MODE.goals ? OBJECTIVE_MODE.goals : OBJECTIVE_MODE.route,
    objectiveDescription: typeof raw.objectiveDescription === "string" ? raw.objectiveDescription : base.objectiveDescription,
    tasks: normalizeObjectiveItems(raw.tasks),
    longTermGoal: normalizeLongTermGoal(raw.longTermGoal),
    shortTermGoals: normalizeObjectiveItems(raw.shortTermGoals),
    autoCheckFrequency: flooredAtLeast(raw.autoCheckFrequency, 0, base.autoCheckFrequency),
    autoCheckEventCount: flooredAtLeast(raw.autoCheckEventCount, 0, base.autoCheckEventCount),
    contextWindow: flooredAtLeast(raw.contextWindow, 1, base.contextWindow),
    injectionDepth: flooredAtLeast(raw.injectionDepth, 1, base.injectionDepth),
    generatePrompt: typeof raw.generatePrompt === "string" ? raw.generatePrompt : base.generatePrompt,
    checkPrompt: typeof raw.checkPrompt === "string" ? raw.checkPrompt : base.checkPrompt,
    injectPrompt: typeof raw.injectPrompt === "string" ? raw.injectPrompt : base.injectPrompt,
    useChatModel: typeof raw.useChatModel === "boolean" ? raw.useChatModel : base.useChatModel,
    providerProfileId: nonBlankStringOrNull(raw.providerProfileId),
    model: nonBlankStringOrNull(raw.model),
  };
}
