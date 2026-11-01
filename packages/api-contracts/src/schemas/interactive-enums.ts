import { z } from "zod";

// Canonical Interactive Runtime vocabulary, re-exported by interactive-schema.ts.
export const experienceCapabilitySchema = z.enum([
  "participants",
  "deterministic_random",
  "model",
  "rp_context",
  "rp_attachment",
]);

export const experienceControllerSchema = z.enum(["human", "script", "model"]);

export const experienceViewerKindSchema = z.enum([
  "human",
  "script",
  "model",
  "observer",
]);

export const experienceSessionStatusSchema = z.enum([
  "active",
  "completed",
  "interrupted",
]);

/**
 * Reducer-output session status — a deliberate subset of session status: a
 * reducer may keep the game `active` or end it `completed`. `interrupted` is
 * host-only (an explicit user end recorded as a system transition), so a script
 * returning it is rejected before persistence.
 */
export const experienceReducerStatusSchema = z.enum(["active", "completed"]);

export const experienceEventVisibilitySchema = z.enum(["public", "private"]);

export const experienceEffectStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

export const experienceEffectKindSchema = z.enum(["model", "timer"]);

export const experienceContextModeSchema = z.enum([
  "none",
  "current_branch",
  "recent",
  "summaries_recent",
  "compact_summary",
]);

export const experienceStarterKindSchema = z.enum(["rules", "visual"]);
