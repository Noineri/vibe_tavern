/**
 * Star-prompt policy — when to ask the user to star the repo, and how long to
 * wait after they say "Later".
 *
 * Pure: no React, no DB, no I/O. The two UI surfaces (the first-run welcome
 * strip in SetupWizard and StarPromptModal) both read their decisions from
 * here so the schedule is defined in exactly one place.
 */
import * as buildConfig from "../build-config.js";

/**
 * Messages to wait before each successive ask. The last value repeats.
 *
 * The first interval is deliberately short: on upgrade an existing user starts
 * from a zero count, and a large first threshold would hide the ask for weeks
 * from exactly the people most likely to star.
 */
export const STAR_PROMPT_INTERVALS = [10, 100, 300] as const;

export interface StarPromptState {
  githubStarred: boolean;
  userMessageCount: number;
  nextStarPromptAt: number;
}

/** The wait length for a given deferral count, clamped to the last interval. */
export function starPromptInterval(deferrals: number): number {
  const index = Math.min(Math.max(deferrals, 0), STAR_PROMPT_INTERVALS.length - 1);
  return STAR_PROMPT_INTERVALS[index]!;
}

/**
 * The new due point after a deferral. `deferralsAfterIncrement` is the
 * deferral count INCLUDING the deferral being processed, so the first "Later"
 * passes 1 and waits 300.
 *
 * Scheduled from the live count rather than the old due point: a suppression
 * guard can let the count run past the due point before the modal opens, and
 * scheduling from a stale due point would shorten the next wait.
 */
export function nextStarPromptAt(userMessageCount: number, deferralsAfterIncrement: number): number {
  return userMessageCount + starPromptInterval(deferralsAfterIncrement);
}

/** Whether the periodic modal should open, ignoring transient UI guards. */
export function isStarPromptDue(state: StarPromptState): boolean {
  if (state.githubStarred) return false;
  return state.userMessageCount >= state.nextStarPromptAt;
}

/**
 * The repo's web URL, derived from the update API base so a fork that
 * overrides VIBE_TAVERN_WEB_UPDATE_API_BASE points its star button at its own
 * repo. version-check.ts builds only api.github.com URLs from this base, so
 * there is no existing helper to reuse.
 */
export function repoWebUrl(): string {
  return buildConfig.UPDATE_API_BASE.replace("https://api.github.com/repos/", "https://github.com/");
}
