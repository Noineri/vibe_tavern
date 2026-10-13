import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import type { Attachment, CoauthorTransport, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderExecutionInput, CachedModelEntry } from "../../infrastructure/ai/provider-execution-types.js";
import type { SendMessageRequest } from "./chat-application-types.js";

/** Per-turn inputs shared by streaming and non-streaming live sends. */
export interface LiveChatSendInput {
  chatId: string;
  content: string;
  attachments?: Attachment[];
  profile: StoredProviderProfileRecord;
  model: string;
  transport?: CoauthorTransport;
  prefill?: string;
  signal?: AbortSignal;
  visionAssets?: { cachedModels: CachedModelEntry[]; visionModel: string | null; assetLoader: (assetId: string) => Promise<Buffer | null>; visionDescribePrompt?: string };
  voiceTranscriber?: ProviderExecutionInput["voiceTranscriber"];
  diceCommit?: SendMessageRequest["diceCommit"];
  experienceCommit?: SendMessageRequest["experienceCommit"];
  /** Optional live co-author editor snapshot; absent preserves legacy assembly. */
  coauthorEditorState?: CoauthorEditorState;
}
