import { z } from "zod";
import { FLY_STEERING_NOTE_MAX_LENGTH } from "./fly-tribunal-schema.js";

/**
 * Optional per-request override for message regeneration.
 *
 * Sent in the body of `POST .../regenerate` and `.../regenerate/stream`. Every
 * field is optional and the whole body is optional, so an empty body (the
 * legacy single-flight regenerate) validates unchanged and resolves via the
 * active profile's `defaultModel` + the chat's `promptPresetId` cascade —
 * byte-identical to pre-queue behavior.
 *
 * Used by the chat generation queue (CHAT_GENERATION_QUEUE_PLAN): each queued
 * job snapshots a `{ model, promptPresetId }` pair. `model` is a KEY (frozen at
 * enqueue); the override model's per-model overlay (samplers/budget/reasoning)
 * is resolved at the adapter's generation-boundary chokepoint. `promptPresetId`
 * overrides the chat's preset for that one generation without mutating the chat
 * row.
 *
 * `steeringNote` (FLY_TRIBUNAL_PLAN FT-2/FT-5, threaded later): a one-shot
 * tribunal hint injected at the user-message level for THIS generation only
 * — absent note = byte-identical legacy prompt. Length-bounded by the fly
 * module's constant; never persisted with the chat.
 */
export const regenerateOverrideSchema = z
  .object({
    model: z.string().min(1).optional(),
    promptPresetId: z.string().min(1).optional(),
    steeringNote: z.string().min(1).max(FLY_STEERING_NOTE_MAX_LENGTH).optional(),
  })
  .optional();

export type RegenerateOverride = z.infer<typeof regenerateOverrideSchema>;
