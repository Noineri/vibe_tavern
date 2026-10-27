import type { ExperienceQueuedAttachmentView } from "../../domain/interactive/experience-service.js";
import type { ExperienceReportStatus } from "../../domain/interactive/experience-report-service.js";

/** Public report operations; never exposes hidden checkpoint state. */
export interface ExperienceReportRuntimeApi {
  /** Read the session's current queued attachment, or null when none is queued. */
  getExperienceQueuedAttachment: (sessionId: string) => Promise<ExperienceQueuedAttachmentView | null>;
  /** Explicit Queue / Add later at the exact client revision. */
  queueExperienceReport: (sessionId: string, body: { expectedRevision: number }) => Promise<ExperienceQueuedAttachmentView>;
  /** Clear only this scope's unbound queue at the exact client revision. */
  clearExperienceReportQueue: (sessionId: string, body: { chatId: string; branchId: string; expectedRevision: number }) => Promise<{ ok: true }>;
  /** Privacy-safe server report status and exact validated-public-event count. */
  getExperienceReportStatus: (sessionId: string) => Promise<ExperienceReportStatus>;
}
