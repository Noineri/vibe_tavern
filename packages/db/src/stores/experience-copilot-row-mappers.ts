// Row mappers for the experience-copilot store (brandId at the DB edge
// only) — extracted from experience-copilot-store.ts when applyRpSync
// (SIDECHAT_PLAN SC-2c) pushed that file past the arch-gate size cap (the
// ratchet's remedy is extraction, never trimming). Pure row → projection
// functions; the store class stays the only reader/writer of the underlying
// columns and calls these directly, so the branding edge does not move.

import { brandId, log, parseStoredAttachments, type ExperienceCopilotThreadId, type ExperienceCopilotMessageId, type AgentThreadContextEventId } from '@vibe-tavern/domain';
import { experienceCopilotThreads, experienceCopilotMessages, agentThreadContextEvents } from '../db-schema.js';
import { parseContextMetrics, parseContextLinks, parseTodo } from './experience-copilot-row-parse.js';
import type { AgentThreadContextEvent } from './agent-thread-context-events.js';
import type { ExperienceCopilotThread, ExperienceCopilotMessage } from './experience-copilot-store.js';

const logger = log.tag('experience-copilot-row-mappers');

export function mapThread(row: typeof experienceCopilotThreads.$inferSelect): ExperienceCopilotThread {
  return {
    id: brandId<ExperienceCopilotThreadId>(row.id),
    scriptId: row.scriptId,
    draftSessionId: row.draftSessionId,
    chatId: row.chatId,
    branchId: row.branchId,
    agentKind: row.agentKind,
    title: row.title,
    archivedAt: row.archivedAt,
    contextMetrics: parseContextMetrics(row.contextMetricsJson, row.id),
    contextLinks: parseContextLinks(row.contextLinksJson, row.id),
    todo: parseTodo(row.todoJson, row.id),
    lastProviderProfileId: row.lastProviderProfileId,
    lastModel: row.lastModel,
    autoCompact: row.autoCompact === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapMessage(row: typeof experienceCopilotMessages.$inferSelect): ExperienceCopilotMessage {
  const attachments = parseStoredAttachments(row.attachmentsJson);
  return {
    id: brandId<ExperienceCopilotMessageId>(row.id),
    threadId: brandId<ExperienceCopilotThreadId>(row.threadId),
    role: row.role,
    content: row.content,
    toolCallsJson: row.toolCallsJson,
    toolCallId: row.toolCallId,
    reasoning: row.reasoning,
    reasoningDurationMs: row.reasoningDurationMs,
    seq: row.seq,
    createdAt: row.createdAt,
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** Map an event row (SC-1); null — after logger.warn — when payload_json is
 *  malformed, so the caller skips that row (listTimeline never throws on a
 *  corrupted event). A NULL column is not malformed: the event carries a
 *  null payload. */
export function mapEvent(row: typeof agentThreadContextEvents.$inferSelect): AgentThreadContextEvent | null {
  let payload: unknown = null;
  if (row.payloadJson !== null) {
    try {
      payload = JSON.parse(row.payloadJson);
    } catch (err) {
      logger.warn(
        'listTimeline: malformed payload_json on event %s of thread %s skipped (%s)',
        row.id,
        row.threadId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
  return {
    id: brandId<AgentThreadContextEventId>(row.id),
    threadId: brandId<ExperienceCopilotThreadId>(row.threadId),
    seq: row.seq,
    kind: row.kind as AgentThreadContextEvent['kind'],
    payload,
    createdAt: row.createdAt,
  };
}
