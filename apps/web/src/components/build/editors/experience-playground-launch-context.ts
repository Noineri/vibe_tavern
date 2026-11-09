/**
 * The launch context ExperiencePlayground reports to the copilot shell
 * (ER-14) — the ONE derivation of the diagnostics launch context.
 *
 * Two sources, one precedence: while a playground session is live the shell
 * receives the session's START-captured envelope (`logLaunchContext` — the
 * exact roster/grants/settings/seed the session runs with; the same
 * captured-at-start contract the launch-context vocabulary documents in
 * experience-copilot-digest.ts, CopilotPlaygroundLogDigestInput). Without a
 * live session the LIVE launch config is reported (the tester digests'
 * context). The debounced auto-derive can land roster/grant updates AFTER
 * start; a live-mirror read at send time would then describe a launch that
 * never happened (CI_WEB_TIMING_FLAKES_REPORT victim ER-14: the shell test's
 * start-time pin held only while the derive had not landed).
 */
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import type { ExperienceCapability } from "@vibe-tavern/domain";
import type { ExperienceParticipant } from "../../../api/types.js";
import { parseOptionalJsonDiagnosed } from "../../../lib/json-parse-diagnostic.js";
import { asSettingsObject } from "./experience-playground-model.js";

/** The component state the live derivation reads. */
export interface LiveLaunchConfigInput {
  participants: ExperienceParticipant[];
  grants: readonly ExperienceCapability[];
  settingsJson: string;
  seed: string;
  lastUsedSeed: string;
  randomStart: boolean;
  humanSeatId: string;
}

/** The launch context reported to the shell: the START-captured session
 *  envelope wins while a session is live (non-null), otherwise the launch
 *  config as currently configured. Settings resolve through the same
 *  plain-object rule in both paths — broken or non-object JSON is omitted
 *  (the launch-context vocabulary carries records only), an absent value
 *  resolves to `{}`. "Random start" reports the LAST used random seed
 *  (shown read-only in the seed input); the manual seed otherwise. */
export function reportedLaunchContext(
  sessionEnvelope: ExperienceCopilotLaunchContext | null,
  live: LiveLaunchConfigInput,
): ExperienceCopilotLaunchContext {
  if (sessionEnvelope !== null) return sessionEnvelope;
  const parsed = parseOptionalJsonDiagnosed(live.settingsJson);
  const settings = parsed.ok
    ? parsed.present
      ? asSettingsObject(parsed.value)
      : {}
    : null;
  const activeSeed = live.randomStart ? live.lastUsedSeed.trim() : live.seed.trim();
  return {
    participants: live.participants,
    capabilityGrants: [...live.grants],
    ...(settings !== null ? { settings } : {}),
    ...(activeSeed !== "" ? { seed: activeSeed } : {}),
    ...(live.humanSeatId !== "" ? { humanSeatId: live.humanSeatId } : {}),
  };
}

/** The START-captured envelope: the exact roster/grants/settings/seed/seat
 *  the session was launched with (as actually sent). Settings are projected
 *  through the same plain-object rule the live derivation uses — a verbatim
 *  non-object payload has no place in the launch-context vocabulary and is
 *  omitted. */
export function startLaunchEnvelope(input: {
  participants: ExperienceParticipant[];
  grants: readonly ExperienceCapability[];
  settings: unknown;
  launchSeed: string;
  humanSeatId: string;
}): ExperienceCopilotLaunchContext {
  const settings = asSettingsObject(input.settings);
  return {
    participants: input.participants,
    capabilityGrants: [...input.grants],
    ...(settings !== null ? { settings } : {}),
    ...(input.launchSeed !== "" ? { seed: input.launchSeed } : {}),
    ...(input.humanSeatId !== "" ? { humanSeatId: input.humanSeatId } : {}),
  };
}
