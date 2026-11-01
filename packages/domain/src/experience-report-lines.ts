import type { ExperiencePublicReport, ExperienceReportEvent } from "./entities.js";

/**
 * Render one public report event without a consumer-specific list marker.
 * String details are prose with an optional frozen actor label; other details
 * retain the legacy formatter's exact type/compact-JSON representation.
 */
export function renderExperienceEventLine(
  event: ExperienceReportEvent,
  participants?: ExperiencePublicReport["participants"],
): string {
  if (typeof event.detail === "string") {
    if (event.participantId === undefined) return event.detail;
    const label = participants?.find((participant) => participant.id === event.participantId)?.label ?? event.participantId;
    return `${label}: ${event.detail}`;
  }

  // Extracted from prompt-pipeline/experience-report.ts::formatEventLine (ERX-1).
  const label = event.type;
  return event.detail !== undefined ? `${label}: ${JSON.stringify(event.detail)}` : label;
}
