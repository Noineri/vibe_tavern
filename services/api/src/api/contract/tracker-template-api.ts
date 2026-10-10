import type { ConfigPatchResponse } from "./session-types.js";
import type { TrackerTemplate } from "@vibe-tavern/domain";

/** Character-owned portable Tracker Template CRUD. */
export interface TrackerTemplateCharacterRuntimeApi {
  getTrackerTemplate: (characterId: string) => Promise<{ template: TrackerTemplate | null }>;
  updateTrackerTemplate: (characterId: string, template: TrackerTemplate) => Promise<{ template: TrackerTemplate }>;
  deleteTrackerTemplate: (characterId: string) => Promise<void>;
}

/** Chat actions that apply or capture a character-owned Tracker Template. */
export interface TrackerTemplateInsightsRuntimeApi {
  applyCharacterTrackerTemplate: (chatId: string) => Promise<ConfigPatchResponse>;
  saveAsCharacterTrackerTemplate: (chatId: string) => Promise<{ template: TrackerTemplate }>;
}

/** The tracker-template facets contributed to the aggregate runtime contract. */
export interface TrackerTemplateApi {
  character: TrackerTemplateCharacterRuntimeApi;
  insights: TrackerTemplateInsightsRuntimeApi;
}
