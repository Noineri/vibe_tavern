import { z } from "zod";

/**
 * User-saved instruction templates for the message AI editor
 * (AI_EDITOR_INSTRUCTION_TEMPLATES) — the word-twin of the format-template
 * library (the LS-10 small-resource pattern): recurring edit/merge
 * instructions stored as named plain text, managed with the same
 * save/rename/delete chrome. `text` is the instruction verbatim — non-empty
 * is the only constraint (the owner's no-arbitrary-input-limits rule).
 */

/** Wire record — as served by GET /api/ai-instruction-templates and mutations. */
export const aiInstructionTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  text: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AiInstructionTemplate = z.infer<typeof aiInstructionTemplateSchema>;

export const aiInstructionTemplateListSchema = z.array(aiInstructionTemplateSchema);

export type AiInstructionTemplateList = z.infer<typeof aiInstructionTemplateListSchema>;

/** Create from the editor's current instruction (the «save-current» flow). */
export const createAiInstructionTemplateSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
});

export type AiInstructionTemplateCreate = z.infer<typeof createAiInstructionTemplateSchema>;

/** Partial update: rename and/or overwrite the stored text. */
export const updateAiInstructionTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});

export type AiInstructionTemplateUpdate = z.infer<typeof updateAiInstructionTemplateSchema>;
