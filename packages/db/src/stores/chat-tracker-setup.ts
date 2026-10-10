import type { InsightsConfig, ObjectiveState } from "@vibe-tavern/domain";
import { eq } from "drizzle-orm";
import type { AppDb } from "../db-connection.js";
import { chats } from "../db-schema.js";

export async function updateChatInsightsConfig(
  db: AppDb,
  id: string,
  insightsConfig: InsightsConfig | undefined,
  updatedAt: string,
) {
  return db
    .update(chats)
    .set({
      updatedAt,
      ...(insightsConfig === undefined ? {} : { insightsConfigJson: JSON.stringify(insightsConfig) }),
    })
    .where(eq(chats.id, id))
    .returning();
}

export async function updateChatObjectiveState(
  db: AppDb,
  id: string,
  objectiveState: ObjectiveState | undefined,
  updatedAt: string,
) {
  return db
    .update(chats)
    .set({
      updatedAt,
      ...(objectiveState === undefined ? {} : { insightsObjectiveStateJson: JSON.stringify(objectiveState) }),
    })
    .where(eq(chats.id, id))
    .returning();
}

/** Atomically replace both tracker setup columns for a chat. */
export async function replaceChatTrackerSetup(
  db: AppDb,
  id: string,
  insightsConfig: InsightsConfig,
  objectiveState: ObjectiveState,
  updatedAt: string,
) {
  return db
    .update(chats)
    .set({
      insightsConfigJson: JSON.stringify(insightsConfig),
      insightsObjectiveStateJson: JSON.stringify(objectiveState),
      updatedAt,
    })
    .where(eq(chats.id, id))
    .returning();
}
