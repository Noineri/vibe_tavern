import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { InsightsRuntimeApi } from "../contract/runtime-api.js";

// Insights — Objective Tracker routes (INSIGHTS_PLAN INS-4). Manual actions
// return via RPC (no SSE); auto background checks persist to
// insightsObjectiveStateJson and the UI reads them on the next snapshot refresh.
// Scene Tracker routes (INS-9) will share this module.

export function createInsightsRoutes(runtime: InsightsRuntimeApi) {
  return new Hono()
    .post("/api/chats/:chatId/insights/objective/generate", zValidator("json", schemas.objectiveModelSchema), async (c) => {
      return c.json(await runtime.generateObjectiveTasks(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/objective/check", zValidator("json", schemas.objectiveModelSchema), async (c) => {
      return c.json(await runtime.checkObjectiveCompletion(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/objective/tasks", zValidator("json", schemas.addObjectiveTaskSchema), async (c) => {
      return c.json(await runtime.addObjectiveTask(c.req.param("chatId"), c.req.valid("json")));
    })
    .patch("/api/chats/:chatId/insights/objective/tasks/:taskId", zValidator("json", schemas.updateObjectiveTaskSchema), async (c) => {
      return c.json(await runtime.updateObjectiveTask(c.req.param("chatId"), c.req.param("taskId"), c.req.valid("json")));
    })
    .delete("/api/chats/:chatId/insights/objective/tasks/:taskId", async (c) => {
      return c.json(await runtime.deleteObjectiveTask(c.req.param("chatId"), c.req.param("taskId")));
    })
    .put("/api/chats/:chatId/insights/objective/description", zValidator("json", schemas.setObjectiveDescriptionSchema), async (c) => {
      return c.json(await runtime.setObjectiveDescription(c.req.param("chatId"), c.req.valid("json")));
    })
    .put("/api/chats/:chatId/insights/objective/config", zValidator("json", schemas.updateObjectiveConfigSchema), async (c) => {
      return c.json(await runtime.updateObjectiveConfig(c.req.param("chatId"), c.req.valid("json")));
    });
}
