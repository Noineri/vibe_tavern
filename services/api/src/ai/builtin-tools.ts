/**
 * Built-in tools using AI SDK's `tool()` helper.
 *
 * Tools are defined with Zod schemas and async execute handlers, then passed
 * directly to `streamText({ tools, maxSteps })`. AI SDK handles the full
 * multi-turn tool-calling loop: validation, execution, routing results back
 * to the LLM, and repeating until the model stops requesting tools.
 *
 * To add a new built-in tool:
 * 1. Define it with `tool({ description, parameters, execute })`
 * 2. Add it to the object returned by `getBuiltinTools()`
 * 3. Done — no registry, no executor wiring needed
 */

import { tool } from "ai";
import { z } from "zod";

// ─── Built-in Tool Definitions ─────────────────────────────────────────

/**
 * Returns all built-in tools as an AI SDK `ToolSet`.
 * Pass the result into `streamText({ tools })`.
 */
export function getBuiltinTools() {
  return {
    roll_dice: tool({
      description: "Roll one or more dice with a specified number of sides. Returns each roll and their total.",
      inputSchema: z.object({
        sides: z.number().int().min(2).describe("Number of sides on each die (e.g. 6, 20)"),
        count: z.number().int().min(1).max(100).optional().describe("Number of dice to roll (default: 1)"),
      }),
      execute: async ({ sides, count = 1 }) => {
        const rolls = Array.from({ length: count }, () =>
          Math.floor(Math.random() * sides) + 1,
        );
        return JSON.stringify({
          rolls,
          total: rolls.reduce((a, b) => a + b, 0),
        });
      },
    }),
  };
}

/** Type of the tool set returned by `getBuiltinTools()`. */
export type BuiltinToolSet = ReturnType<typeof getBuiltinTools>;
