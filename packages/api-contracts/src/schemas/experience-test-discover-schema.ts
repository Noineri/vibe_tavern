/**
 * Discover-only request for unsaved experience rules. Split out of
 * interactive-schema.ts for the file-size ratchet; re-exported from
 * schemas/index.ts so every consumer keeps importing from the package root.
 */
import { z } from "zod";
import {
  INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  INTERACTIVE_SCHEMA_MAX_STRING,
} from "./interactive-schema.js";

/** Discover the definition of UNSAVED rules source without running `create`:
 *  no settings, roster, grants, seed, or actions are accepted (nothing is
 *  executed beyond the rules body), so the strict shape rejects them. */
export const experienceTestDiscoverRequestSchema = z.object({
  rulesCode: z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_STATE_BYTES),
  scriptName: z.string().max(INTERACTIVE_SCHEMA_MAX_STRING).optional(),
}).strict();

export type ExperienceTestDiscoverRequestDto = z.infer<typeof experienceTestDiscoverRequestSchema>;
