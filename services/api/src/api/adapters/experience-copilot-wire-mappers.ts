/**
 * Domain → wire mappers for the experience-copilot adapter (ER-7; extracted
 * from experience-copilot-adapter.ts for the size ratchet — SIDECHAT_PLAN
 * SC-7 grew the adapter past its cap, and the mappers are the cohesive unit
 * that moved out).
 *
 * Field-for-field: the store's branded ids are phantom string brands (already
 * `string`-assignable), so the only job here is the explicit object literal
 * that pins the nullability contract (nullable fields stay `null`, never
 * `undefined`).
 */

import type { ExperienceCopilotThread, ExperienceCopilotMessage, CopilotContextMetrics, AgentKindSettings, ChatAgentSettings } from "@vibe-tavern/db";
import type { ChatMode } from "@vibe-tavern/domain";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics, AgentKindSettingsWire, AgentChatSettingsWire } from "@vibe-tavern/api-contracts";

export function toThreadWire(t: ExperienceCopilotThread): ExperienceCopilotThreadWire {
  return {
    id: t.id,
    scriptId: t.scriptId,
    draftSessionId: t.draftSessionId,
    title: t.title,
    archivedAt: t.archivedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    metrics: t.contextMetrics ? toMetricsWire(t.contextMetrics) : null,
    contextLinks: t.contextLinks,
    todo: t.todo,
  };
}

/** Map the store's parsed metrics (structurally identical to the wire shape)
 *  into the api-contracts type. Field-for-field so the nullability/union
 *  contract is explicit (never `undefined`); SC-9's optional `segments`
 *  rides along only when present (kinds without segments stay without). */
export function toMetricsWire(m: CopilotContextMetrics): ExperienceCopilotContextMetrics {
  return {
    systemTokens: m.systemTokens,
    digestTokens: m.digestTokens,
    historyTokens: m.historyTokens,
    totalTokens: m.totalTokens,
    attachedTokens: m.attachedTokens,
    budgetTokens: m.budgetTokens,
    reserveTokens: m.reserveTokens,
    source: m.source,
    measuredAt: m.measuredAt,
    ...(m.segments !== undefined ? { segments: [...m.segments] } : {}),
  };
}

export function toMessageWire(m: ExperienceCopilotMessage): ExperienceCopilotMessageWire {
  return {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    content: m.content,
    toolCallsJson: m.toolCallsJson,
    toolCallId: m.toolCallId,
    createdAt: m.createdAt,
  };
}

/** Map the db store's kind-settings row into the api-contracts type —
 *  field-for-field so the nullability contract is explicit (nullable fields
 *  stay `null`). The one NON-row field is SC-7b's `servedChatModes`: chat
 *  modes are registry/descriptor facts, never stored, so the caller passes
 *  the kind's `servesChatModes` (the one source) beside the row. */
export function toKindSettingsWire(
  s: AgentKindSettings,
  servesChatModes: readonly ChatMode[],
): AgentKindSettingsWire {
  return {
    agentKind: s.agentKind,
    providerProfileId: s.providerProfileId,
    modelName: s.modelName,
    defaultProfileId: s.defaultProfileId,
    updatedAt: s.updatedAt,
    servesChatModes: [...servesChatModes],
  };
}

/** Map the db store's chat-settings row (structurally identical to the
 *  wire shape) into the api-contracts type — field-for-field so the
 *  nullability contract is explicit (nullable fields stay `null`). */
export function toChatSettingsWire(s: ChatAgentSettings): AgentChatSettingsWire {
  return {
    chatId: s.chatId,
    agentKind: s.agentKind,
    profileId: s.profileId,
    updatedAt: s.updatedAt,
  };
}
