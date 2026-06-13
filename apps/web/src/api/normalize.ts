import type { AppSnapshot, AppMessage } from "./types.js";

/**
 * Normalise a snapshot received from the backend WITHOUT destroying field
 * absence (Phase 3.4.1 — the absence pipeline).
 *
 * An unset field must stay unset so {@link ingestSnapshot} can tell the
 * difference between "the server omitted this field" (preserve whatever the
 * store already holds) and "the server sent an empty value" (replace with the
 * empty value). Previously this function coerced every absent array to `[]`
 * and every absent scalar to `null`/`{}`, which silently converted "omit"
 * into "wipe" and made ingestSnapshot's presence guards dead code.
 *
 * Only fields that are actually present get per-field/per-element shaping
 * (character field defaults, message variant normalisation). Absent fields
 * are passed through untouched via the shallow spread.
 */
export function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const out: AppSnapshot = { ...snapshot };

  if ("character" in snapshot && snapshot.character) {
    out.character = {
      ...snapshot.character,
      firstMessage: snapshot.character.firstMessage ?? null,
      alternateGreetings: Array.isArray(snapshot.character.alternateGreetings)
        ? snapshot.character.alternateGreetings
        : [],
      postHistoryInstructions: snapshot.character.postHistoryInstructions ?? null,
      creatorNotes: snapshot.character.creatorNotes ?? null,
      depthPrompt: snapshot.character.depthPrompt ?? null,
      depthPromptDepth: snapshot.character.depthPromptDepth ?? null,
      depthPromptRole: snapshot.character.depthPromptRole ?? null,
      tags: Array.isArray(snapshot.character.tags) ? snapshot.character.tags : [],
    };
  }

  if ("messages" in snapshot && Array.isArray(snapshot.messages)) {
    out.messages = snapshot.messages.map(normalizeMessage);
  }

  return out;
}

export function normalizeMessage(message: AppMessage): AppMessage {
  const variants = Array.isArray(message.variants) ? message.variants : [];
  const selectedVariantIndex =
    typeof message.selectedVariantIndex === "number" ? message.selectedVariantIndex : null;

  return {
    ...message,
    variants,
    selectedVariantIndex,
  };
}
