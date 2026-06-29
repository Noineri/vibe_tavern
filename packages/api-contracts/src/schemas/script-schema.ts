import { z } from "zod";

export const createScriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  code: z.string().optional().default(""),
  scopeType: z.string(),
  characterId: z.string().optional(),
  personaId: z.string().optional(),
  chatId: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.number().optional().default(0),
});

export const updateScriptSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  code: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

/** Reassign a script's scope atomically (PR-6 binding). Clears stale FKs.
 *  `ownerId` is omitted/null for 'global'. */
export const setScriptScopeSchema = z.object({
  scopeType: z.enum(['global', 'character', 'persona', 'chat']),
  ownerId: z.string().nullable().optional(),
});

export const testScriptSchema = z.object({
  /** Simulated chat messages for test execution */
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional().default([]),
  /** Character name for test context */
  characterName: z.string().optional().default("Assistant"),
  /** Character personality for test context */
  characterPersonality: z.string().optional().default(""),
  /** Character scenario for test context */
  characterScenario: z.string().optional().default(""),
  /** Persona name — when provided, exposed as `context.persona.name` (P3) */
  personaName: z.string().optional(),
  /** Persona description — exposed as `context.persona.description` (P3) */
  personaDescription: z.string().optional(),
  /** Last message text (shorthand for messages[messages.length-1]) */
  lastMessage: z.string().optional().default(""),
});

export const importScriptSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("js"),
    code: z.string().min(1),
    name: z.string().optional(),
    scopeType: z.string().optional().default("character"),
    characterId: z.string().optional(),
    personaId: z.string().optional(),
    chatId: z.string().optional(),
  }),
  z.object({
    format: z.literal("json"),
    jsonText: z.string().min(1),
    scopeType: z.string().optional().default("character"),
    characterId: z.string().optional(),
    personaId: z.string().optional(),
    chatId: z.string().optional(),
  }),
]);

// ─── Link management ─────────────────────────────────────────────────────────
// Mirrors lorebookLinkSchema / setLorebookLinksSchema: a script can be M:N
// bound to characters and personas on top of its home-scope FK.

export const scriptLinkSchema = z.object({
  targetType: z.enum(["character", "persona"]),
  targetId: z.string().min(1),
});

export const setScriptLinksSchema = z.object({
  links: z.array(scriptLinkSchema),
});
