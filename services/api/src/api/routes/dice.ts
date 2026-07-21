import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { DiceRuntimeApi } from "../contract/runtime-api.js";

/**
 * Dice routes (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B8).
 *
 * Seven endpoints under `/api/chats/:chatId/dice`:
 * GET  /definitions       — enabled Dice scripts + check descriptors
 * GET  /pending           — both lanes' state
 * POST /roll              — execute a server-authoritative roll
 * DELETE /rolls/:rollId   — remove one Normal pending result
 * DELETE /pending         — clear the Normal lane
 * PATCH /rolls/:rollId    — set included/excluded (Immersive)
 * POST /rolls/:rollId/choose — finalize a choose-policy attempt
 */
export function createDiceRoutes(runtime: DiceRuntimeApi) {
  return new Hono()
    // GET /definitions — enabled Dice scripts + check descriptors
    .get("/api/chats/:chatId/dice/definitions", async (c) => {
      const chatId = c.req.param("chatId");
      const result = await runtime.getDefinitions(chatId);
      return c.json(result);
    })

    // GET /pending — both lanes' state
    .get("/api/chats/:chatId/dice/pending", async (c) => {
      const chatId = c.req.param("chatId");
      const branchId = c.req.query("branchId");
      if (!branchId) {
        return c.json({ error: "branchId query parameter is required" }, 400);
      }
      const result = await runtime.getPending(chatId, branchId);
      return c.json(result);
    })

    // POST /roll — execute a server-authoritative roll
    .post("/api/chats/:chatId/dice/roll", zValidator("json", schemas.diceRollRequestSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      const result = await runtime.roll(chatId, body);
      return c.json(result);
    })

    // DELETE /rolls/:rollId — remove one Normal pending result
    .delete("/api/chats/:chatId/dice/rolls/:rollId", async (c) => {
      const chatId = c.req.param("chatId");
      const rollId = c.req.param("rollId");
      await runtime.removeRoll(chatId, rollId);
      return c.json({ ok: true });
    })

    // DELETE /pending — clear the Normal lane
    .delete("/api/chats/:chatId/dice/pending", async (c) => {
      const chatId = c.req.param("chatId");
      const branchId = c.req.query("branchId");
      if (!branchId) {
        return c.json({ error: "branchId query parameter is required" }, 400);
      }
      await runtime.clearLane(chatId, branchId);
      return c.json({ ok: true });
    })

    // PATCH /rolls/:rollId — set included/excluded (Immersive)
    .patch("/api/chats/:chatId/dice/rolls/:rollId", zValidator("json", schemas.diceSetIncludedSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const rollId = c.req.param("rollId");
      const body = c.req.valid("json");
      await runtime.setIncluded(chatId, rollId, body.included);
      return c.json({ ok: true });
    })

    // POST /rolls/:rollId/choose — finalize a choose-policy attempt
    .post("/api/chats/:chatId/dice/rolls/:rollId/choose", zValidator("json", schemas.diceChooseFinalSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const rollId = c.req.param("rollId");
      const body = c.req.valid("json");
      await runtime.chooseFinal(chatId, rollId, body.attemptId);
      return c.json({ ok: true });
    });
}
