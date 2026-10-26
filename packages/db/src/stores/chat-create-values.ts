import type { ChatMode, InsightsConfig, ObjectiveState } from "@vibe-tavern/domain";

export interface CreateChatInput {
  characterId: string;
  personaId?: string;
  title: string;
  promptPresetId: string | null;
  /** Chat mode. Omit/undefined → DB default 'rp'. */
  mode?: ChatMode;
  /** Optional applied tracker-template config. Omit to leave the DB default JSON byte-for-byte intact. */
  insightsConfig?: InsightsConfig;
  /** Optional applied tracker-template objective state. Omit to leave the DB default JSON byte-for-byte intact. */
  insightsObjectiveState?: ObjectiveState;
}

export function createChatInsertValues(
  data: CreateChatInput & { id: string; activeBranchId: string; createdAt: string; updatedAt: string },
) {
  return {
    id: data.id,
    characterId: data.characterId,
    personaId: data.personaId ?? null,
    activeBranchId: data.activeBranchId,
    promptPresetId: data.promptPresetId,
    mode: data.mode,
    title: data.title,
    summary: "",
    messageHistoryLimit: 0,
    autoSummaryConfigJson: '{"enabled":false,"everyN":20,"useChatModel":true}',
    ...(data.insightsConfig !== undefined
      ? { insightsConfigJson: JSON.stringify(data.insightsConfig) }
      : {}),
    ...(data.insightsObjectiveState !== undefined
      ? { insightsObjectiveStateJson: JSON.stringify(data.insightsObjectiveState) }
      : {}),
    status: "active" as const,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}
