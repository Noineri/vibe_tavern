import type { ExperiencePublicReport, ExperienceReportEvent } from "./entities.js";

/** Message UI transport limit; full frozen reports remain available to the Writer. */
export const EXPERIENCE_MESSAGE_REPORT_EVENT_LIMIT = 100;

export interface ExperienceMessageReport extends ExperiencePublicReport {
  // Transport arrays are writable for the canonical Immer store; consumers
  // still treat each received report as a frozen historical value.
  participants?: { id: string; label: string }[];
  events: ExperienceReportEvent[];
  /** Total public events, including any omitted from the bounded preview. */
  eventCount: number;
}

/** One public-only projection for committed messages and send-time capture. */
export function toExperienceMessageReport(report: ExperiencePublicReport): ExperienceMessageReport {
  return {
    title: report.title,
    ...(report.summary !== undefined ? { summary: report.summary } : {}),
    ...(report.participants !== undefined ? { participants: report.participants.map(({ id, label }) => ({ id, label })) } : {}),
    eventCount: report.events.length,
    events: report.events.slice(-EXPERIENCE_MESSAGE_REPORT_EVENT_LIMIT),
  };
}
