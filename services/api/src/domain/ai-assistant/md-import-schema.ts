/**
 * Zod schema for MD character import.
 *
 * Used with Vercel AI SDK `streamObject` to parse arbitrary Markdown
 * character descriptions into structured character card fields.
 */
import { z } from "zod";

export const mdImportSchema = z.object({
  name: z.string().describe("Character name"),
  tagline: z.string().optional().describe("Short subtitle or tagline"),
  description: z.string().optional().describe("Public bio / overview"),
  personality: z.string().optional().describe("Full personality section"),
  scenario: z.string().optional().describe("Scenario / setting"),
  firstMessage: z.string().optional().describe("First message / greeting"),
  exampleMessages: z.array(z.string()).optional().describe("Example dialogue exchanges"),
  creatorNotes: z.string().optional().describe("Anything that doesn't fit elsewhere"),
  additionalCharacters: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    personality: z.string().optional(),
  })).optional().describe("Additional characters found in the same file"),
});

export type MdImportResult = z.infer<typeof mdImportSchema>;
