import { experienceEventSchema } from "@vibe-tavern/api-contracts";
import type { AtomicReportData, ExperienceAttachmentRow, ExperienceSessionRow, ExperienceStepRow, StoreContainer } from "@vibe-tavern/db";
import type { ExperienceActionDescriptor, ExperienceParticipant, ExperiencePublicReport, ExperienceReportEvent } from "@vibe-tavern/domain";

import type { ExperienceQueuedAttachmentView } from "./experience-service.js";
import { storeAttachmentToReportSnapshot } from "./experience-report-snapshot.js";
import type { ExperienceApiError, ExperienceResult } from "./experience-shared.js";
import { err, ok } from "./experience-shared.js";

export interface ExperienceReportStatus {
  revision: number;
  reportFrontier: number;
  pendingPublicEventCount: number;
  queuedAttachment: ExperienceQueuedAttachmentView | null;
}

export interface StartReportProjection {
  projection: unknown;
  legalActions: readonly ExperienceActionDescriptor[];
  participants: readonly ExperienceParticipant[];
}

/**
 * Owns report composition only: journal events are defensively filtered to the
 * public contract, while authoritative state is serialized exclusively into the
 * opaque checkpoint passed to ExperienceStore's transactional freeze cores.
 */
export class ExperienceReportService {
  constructor(private readonly stores: StoreContainer) {}

  buildStartReport(session: ExperienceSessionRow, source: StartReportProjection): AtomicReportData {
    const event: ExperienceReportEvent = {
      type: "experience_started",
      detail: {
        name: session.manifestName,
        participants: source.participants.map((participant) => ({
          id: participant.id,
          label: participant.label,
          controller: participant.controller,
        })),
        projection: source.projection,
        legalActions: source.legalActions.map((action) => ({
          type: action.type,
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.participantId !== undefined ? { participantId: action.participantId } : {}),
        })),
        ...(source.legalActions[0]?.participantId !== undefined ? { firstActor: source.legalActions[0].participantId } : {}),
      },
    };
    return this.freezeData(session, { title: session.manifestName, events: [event] });
  }

  async queue(sessionId: string, expectedRevision: number): Promise<ExperienceResult<ExperienceQueuedAttachmentView>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) return this.sessionNotFound(sessionId);
    if (session.revision !== expectedRevision) return this.staleRevision(expectedRevision, session.revision);

    const existing = await this.stores.experiences.getQueuedAttachmentForSession(sessionId);
    const report = this.mergeReport(session, existing, await this.stores.experiences.getSteps(sessionId));
    if (report.events.length === 0 && existing === null) {
      return err({ status: 422, code: "no_public_events", message: "There are no public experience events to queue" });
    }

    const frozen = this.stores.experiences.freezeReport(this.freezeData(session, report));
    if (!frozen.ok) return this.freezeConflict(frozen.conflict, session.revision);
    return ok(toQueuedAttachmentView(frozen.attachment));
  }

  async getStatus(sessionId: string): Promise<ExperienceResult<ExperienceReportStatus>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) return this.sessionNotFound(sessionId);
    const [steps, attachment] = await Promise.all([
      this.stores.experiences.getSteps(sessionId),
      this.stores.experiences.getQueuedAttachmentForSession(sessionId),
    ]);
    return ok({
      revision: session.revision,
      reportFrontier: session.reportFrontier,
      pendingPublicEventCount: publicEventsAfter(steps, session.reportFrontier).length,
      queuedAttachment: attachment ? toQueuedAttachmentView(attachment) : null,
    });
  }

  async finish(sessionId: string, expectedRevision: number): Promise<ExperienceResult<ExperienceQueuedAttachmentView | null>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) return this.sessionNotFound(sessionId);
    if (session.activeSlot === null) {
      const existing = await this.stores.experiences.getQueuedAttachmentForSession(sessionId);
      return ok(existing ? toQueuedAttachmentView(existing) : null);
    }
    if (session.revision !== expectedRevision) return this.staleRevision(expectedRevision, session.revision);

    const steps = await this.stores.experiences.getSteps(sessionId);
    const existing = await this.stores.experiences.getQueuedAttachmentForSession(sessionId);
    const report = this.mergeReport(session, existing, steps);
    const manualFinish = session.status === "active";
    if (manualFinish) {
      report.events.push({ type: "experience_finished", detail: "The user decided to end the game." });
    }
    const checkpointSession = manualFinish
      ? { ...session, activeSlot: null, revision: session.revision + 1, reportFrontier: session.revision + 1, status: "interrupted" }
      : { ...session, activeSlot: null, reportFrontier: session.revision };
    const finished = this.stores.experiences.finishSessionWithFinalReport(
      sessionId,
      expectedRevision,
      this.atomicData(checkpointSession, report),
    );
    if (!finished.ok) {
      if (finished.conflict === "session_not_found") return this.sessionNotFound(sessionId);
      return this.staleRevision(expectedRevision, session.revision);
    }
    return ok(finished.attachment ? toQueuedAttachmentView(finished.attachment) : null);
  }

  private mergeReport(
    session: ExperienceSessionRow,
    existing: ExperienceAttachmentRow | null,
    steps: readonly ExperienceStepRow[],
  ): { title: string; summary?: string; events: ExperienceReportEvent[] } {
    const snapshot = existing ? storeAttachmentToReportSnapshot(existing) : null;
    return {
      title: snapshot?.title ?? session.manifestName,
      ...(snapshot?.summary !== undefined ? { summary: snapshot.summary } : {}),
      events: [...(snapshot?.events ?? []), ...publicEventsAfter(steps, session.reportFrontier)],
    };
  }

  private freezeData(session: ExperienceSessionRow, report: ExperiencePublicReport): AtomicReportData & { chatId: string; branchId: string; sessionId: string; sessionRevision: number } {
    return {
      chatId: session.chatId,
      branchId: session.branchId,
      sessionId: session.id,
      sessionRevision: session.revision,
      ...this.atomicData(session, report),
    };
  }

  private atomicData(session: ExperienceSessionRow, report: ExperiencePublicReport): AtomicReportData {
    return {
      kind: "report",
      publicEventsJson: JSON.stringify(report),
      hiddenStateCheckpointJson: JSON.stringify({
        version: 1,
        identity: { sessionId: session.id, chatId: session.chatId, branchId: session.branchId },
        revision: session.revision,
        status: session.status,
        currentState: parseCheckpointState(session.currentStateJson),
        random: { seed: session.randomSeed, cursor: session.randomCursor },
        sources: {
          rules: { id: session.rulesId, revision: session.rulesRevision, hash: session.rulesSourceHash },
          visual: session.visualId === null ? null : { id: session.visualId, revision: session.visualRevision, hash: session.visualSourceHash },
        },
      }),
      rulesSourceHash: session.rulesSourceHash,
      visualSourceHash: session.visualSourceHash,
    };
  }

  private sessionNotFound(sessionId: string): ExperienceResult<never> {
    return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
  }

  private staleRevision(expectedRevision: number, currentRevision: number): ExperienceResult<never> {
    return err({ status: 409, code: "stale_revision", message: `Report expected revision ${expectedRevision}, session is at ${currentRevision}`, currentRevision });
  }

  private freezeConflict(conflict: string, currentRevision: number): ExperienceResult<never> {
    if (conflict === "session_not_found") return err({ status: 404, code: "session_not_found", message: "Session not found" });
    return err({ status: 409, code: "stale_revision", message: "Report frontier changed before queue", currentRevision });
  }
}

/** Strip malformed/private journal entries before they can enter a public DTO. */
function publicEventsAfter(steps: readonly ExperienceStepRow[], frontier: number): ExperienceReportEvent[] {
  const events: ExperienceReportEvent[] = [];
  for (const step of steps) {
    if ((step.appliedRevision ?? -1) <= frontier) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(step.emittedEventsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const event of parsed) {
      events.push(...publicEvents([event]));
    }
  }
  return events;
}

function publicEvents(values: readonly unknown[]): ExperienceReportEvent[] {
  const events: ExperienceReportEvent[] = [];
  for (const value of values) {
    const parsed = experienceEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.visibility !== "public") continue;
    events.push(parsed.data.detail === undefined ? { type: parsed.data.type } : { type: parsed.data.type, detail: parsed.data.detail });
  }
  return events;
}

function parseCheckpointState(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function toQueuedAttachmentView(attachment: ExperienceAttachmentRow): ExperienceQueuedAttachmentView {
  const snapshot = storeAttachmentToReportSnapshot(attachment);
  return {
    id: attachment.id,
    chatId: attachment.chatId,
    branchId: attachment.branchId,
    sessionId: attachment.sessionId,
    sessionRevision: attachment.sessionRevision,
    queueRevision: attachment.queueRevision,
    kind: attachment.kind,
    publicReport: snapshot === null ? null : {
      title: snapshot.title,
      ...(snapshot.summary !== undefined ? { summary: snapshot.summary } : {}),
      events: snapshot.events,
    },
    rulesSourceHash: attachment.rulesSourceHash,
    visualSourceHash: attachment.visualSourceHash,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}
