/**
 * Re-export of the domain Whisper roster (STT_PLAN ST-3) for web-side import
 * ergonomics — the roster itself lives in `@vibe-tavern/domain` because the
 * server-side mirror consumes the SAME list as its repository allowlist.
 */

export {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL_ID,
  findWhisperModel,
  whisperMirrorRepos,
} from "@vibe-tavern/domain";
export type { WhisperModelInfo } from "@vibe-tavern/domain";
