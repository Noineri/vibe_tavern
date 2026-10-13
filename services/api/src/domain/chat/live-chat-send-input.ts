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
  /** STT_PLAN ST-6: profile-bound transcriber for voice-note attachments. */
  voiceTranscriber?: ProviderExecutionInput["voiceTranscriber"];
  /** DICE-B11: optional commit intent threaded into `prepareLiveTurn` so the
   *  user-message insert and pending-lane bind share one atomic transaction.
   *  Absent ⇒ no-Dice send behavior (byte-for-byte current path). */
  diceCommit?: SendMessageRequest["diceCommit"];
  /** IR-51: optional experience attachment commit intent threaded into
   *  `prepareLiveTurn` so the user-message insert and the queued-attachment
   *  verify-and-bind share one atomic transaction (composed with the Dice
   *  bind when both are present). Absent ⇒ no-experience send behavior.
   *  Streaming uses this shared input, so it has the same preparation contract. */
  experienceCommit?: SendMessageRequest["experienceCommit"];
  /** Optional live co-author editor snapshot; absent preserves legacy assembly. */
  coauthorEditorState?: CoauthorEditorState;
}
