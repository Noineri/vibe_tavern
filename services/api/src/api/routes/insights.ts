import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { InsightsRuntimeApi } from "../contract/runtime-api.js";

// Insights — Objective Tracker routes (INSIGHTS_PLAN INS-4). Manual actions
// return directly; automatic work stays fire-and-forget and is delivered through
// the target-scoped completion-refresh join below. Scene Tracker reuses it in INS-9.

export function createInsightsRoutes(runtime: InsightsRuntimeApi) {
  return new Hono()
    .post("/api/chats/:chatId/insights/completion-refresh", zValidator("json", schemas.insightsCompletionRefreshSchema), async (c) => {
      return c.json(await runtime.refreshInsightsCompletion(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/objective/generate", zValidator("json", schemas.objectiveModelSchema), async (c) => {
      return c.json(await runtime.generateObjectiveTasks(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/objective/check", zValidator("json", schemas.objectiveModelSchema), async (c) => {
      return c.json(await runtime.checkObjectiveCompletion(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/objective/tasks", zValidator("json", schemas.addObjectiveTaskSchema), async (c) => {
      return c.json(await runtime.addObjectiveTask(c.req.param("chatId"), c.req.valid("json")));
    })
    .put("/api/chats/:chatId/insights/objective/tasks/reorder", zValidator("json", schemas.reorderObjectiveTasksSchema), async (c) => {
      return c.json(await runtime.reorderObjectiveTasks(c.req.param("chatId"), c.req.valid("json")));
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
    })
    // ─── Scene Tracker (SCENE_TRACKER_PLAN SCN-9) — immutable variant ownership ──
    .post("/api/chats/:chatId/insights/scene/generate", zValidator("json", schemas.sceneGenerateSchema), async (c) => {
      return c.json(await runtime.generateScene(c.req.param("chatId"), c.req.valid("json"), c.req.raw.signal));
    })
    .post("/api/chats/:chatId/insights/scene/edit", zValidator("json", schemas.sceneEditSchema), async (c) => {
      return c.json(await runtime.editScene(c.req.param("chatId"), c.req.valid("json")));
    })
    .post("/api/chats/:chatId/insights/scene/delete", zValidator("json", schemas.sceneTargetBodySchema), async (c) => {
      return c.json(await runtime.deleteScene(c.req.param("chatId"), c.req.valid("json")));
    })
    .post("/api/chats/:chatId/insights/scene/cancel", zValidator("json", schemas.sceneTargetBodySchema), async (c) => {
      return c.json(runtime.cancelScene(c.req.param("chatId"), c.req.valid("json")));
    })
    .post("/api/chats/:chatId/insights/scene/status", zValidator("json", schemas.sceneTargetBodySchema), async (c) => {
      return c.json(await runtime.getSceneStatus(c.req.param("chatId"), c.req.valid("json")));
    });
}
