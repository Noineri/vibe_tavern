/**
 * Whisper model language-capability helper (STT_PLAN ST-4a): English-only
 * (.en) Whisper checkpoints REJECT an explicit language hint (the tokenizer
 * errors on it — the same rule the worker's ASR-option builder enforces).
 * The editor consults this to hide the optional language field for
 * English-only roster models. Pure; mirrors the roster's `englishOnly` flag.
 */

import { findWhisperModel } from "@vibe-tavern/domain";

/** True when the model accepts an explicit language hint. Unknown model ids
 *  (e.g. free-typed ids) are NOT assumed English-only — a language field
 *  stays available rather than silently refusing input. */
export function whisperAcceptsLanguage(modelId: string): boolean {
  const entry = findWhisperModel(modelId);
  if (entry !== null) return !entry.englishOnly;
  return true;
}