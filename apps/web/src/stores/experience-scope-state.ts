import { ExperienceApiError } from "../api/experience-api.js";
import type { ExperienceActionIntent, ExperienceScopeState, ExperienceState } from "./experience-store.js";

export function emptyScope(): ExperienceScopeState {
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

/** Collision-safe scope key: the bounded ids can contain delimiter characters. */
export function scopeKey(chatId: string, branchId: string): string {
  return JSON.stringify([chatId, branchId]);
}

/** Dedup key for one action intent (type + seat + payload). */
export function actionIntentKey(intent: ExperienceActionIntent): string {
  return JSON.stringify([intent.type, intent.participantId ?? null, intent.payload ?? null]);
}

export function scopeDraft(s: ExperienceState, key: string): ExperienceScopeState {
  return s.byScope[key] ?? (s.byScope[key] = emptyScope());
}

export function isNoActiveSessionError(err: unknown): boolean {
  return err instanceof ExperienceApiError && err.status === 404 && err.code === "no_active_session";
}

export function recordError(scope: ExperienceScopeState, err: unknown): void {
  scope.lastError = err instanceof Error ? err.message : String(err);
  scope.lastApiError = err instanceof ExperienceApiError ? err : null;
}

export function clearError(scope: ExperienceScopeState): void {
  scope.lastError = null;
  scope.lastApiError = null;
}

/** Clear only active-session resources. A retained terminal queue survives
 * no-active-session discovery until an authoritative refresh or explicit clear. */
export function clearActiveSessionResources(scope: ExperienceScopeState): void {
  scope.session = null;
  scope.effects = [];
  scope.reportStatus = null;
  scope.contextStatus = null;
}
