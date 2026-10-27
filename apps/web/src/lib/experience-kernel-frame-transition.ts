import type { experienceTransitionSchema } from "@vibe-tavern/api-contracts/interactive";
import type { ExperienceTransition } from "@vibe-tavern/domain";
import type { z } from "zod";

/** Map an already-validated frame transition to present-keyed domain envelopes. */
export function normalizeFrameTransition(data: z.output<typeof experienceTransitionSchema>): ExperienceTransition {
  // `status` is "active" | "completed" (schema-narrowed); effects are mapped
  // explicitly to present-keyed canonical envelopes (same as the server kernel).
  return {
    state: data.state,
    status: data.status,
    events: data.events.map((event) => ({
      visibility: event.visibility,
      type: event.type,
      ...(event.participantId !== undefined ? { participantId: event.participantId } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
    })),
    ...(data.effects !== undefined
      ? { effects: data.effects.map((effect) => ({ kind: effect.kind, request: effect.request })) }
      : {}),
    ...(data.message !== undefined ? { message: data.message } : {}),
  };
}
