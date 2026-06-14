import { Hono } from "hono";
import type { ProviderRuntimeApi } from "../api/contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import { isDomainError, providerError } from "../errors.js";
import { tokenizeText } from "../infrastructure/ai/tokenizer-service.js";

export function createProviderRoutes(runtime: ProviderRuntimeApi) {
  return new Hono()
    .get("/api/providers", async (c) => {
      const profiles = await runtime.listProviderProfiles();
      for (const p of profiles) {
        console.log(`[ROUTE] GET /api/providers -> id=${p.id} visionModel=${p.visionModel}`);
      }
      return c.json(profiles);
    })
    .get("/api/providers/:providerId", async (c) => {
      return c.json(await runtime.fetchProviderProfile(c.req.param("providerId")));
    })
    .delete("/api/providers/:providerId", async (c) => {
      runtime.deleteProviderProfile(c.req.param("providerId"));
      return c.json({ ok: true });
    })
    .patch("/api/providers/:providerId", zValidator("json", schemas.updateProviderProfileSchema), async (c) => {
      const body = c.req.valid("json");
      console.log(`[ROUTE] PATCH /api/providers/${c.req.param("providerId")} visionModel=${(body as Record<string, unknown>).visionModel} fields=${Object.keys(body).join(',')}`);
      const result = await runtime.updateProviderProfile(c.req.param("providerId"), body);
      console.log(`[ROUTE] PATCH result id=${result.id} visionModel=${result.visionModel}`);
      return c.json(result);
    })
    .post("/api/providers/test", zValidator("json", schemas.testProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.testProviderDraft({ ...body, providerType: body.providerType }));
    })
    .post("/api/providers", zValidator("json", schemas.saveProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.saveProviderDraft(body));
    })
    .post("/api/providers/:providerId/activate", async (c) => {
      return c.json(await runtime.activateProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/fetch-models", zValidator("json", schemas.fetchModelsSchema), async (c) => {
      const body = c.req.valid("json");
      const baseUrl = body?.baseUrl ?? "";
      const apiKey = body?.apiKey ?? "";
      if (!baseUrl.trim()) {
        return c.json({ error: "baseUrl is required." }, 400);
      }
      try {
        const models = await runtime.fetchModelsByEndpoint(baseUrl, apiKey, body?.providerType);
        return c.json({ models });
      } catch (err) {
        if (isDomainError(err)) throw err;
        throw providerError(err instanceof Error ? err.message : "Failed to fetch models.");
      }
    })
    .post("/api/providers/test-chat", zValidator("json", schemas.testChatSchema), async (c) => {
      const body = c.req.valid("json");
      const baseUrl = body?.baseUrl ?? "";
      const apiKey = body?.apiKey ?? "";
      const model = body?.model ?? "";
      if (!baseUrl || !model) {
        return c.json({ error: "baseUrl and model are required." }, 400);
      }
      return c.json(await runtime.testProviderChatByEndpoint({ baseUrl, apiKey, model, providerType: body?.providerType }));
    })
    .post("/api/providers/:providerId/models", async (c) => {
      try {
        return c.json(await runtime.fetchProviderModels(c.req.param("providerId")));
      } catch (err) {
        if (isDomainError(err)) throw err;
        throw providerError(err instanceof Error ? err.message : "Failed to fetch provider models.");
      }
    })
    .get("/api/providers/:providerId/model-favorites", async (c) => {
      return c.json(await runtime.listFavoriteProviderModels(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/model-favorites", zValidator("json", schemas.favoriteProviderModelSchema), async (c) => {
      return c.json(await runtime.addFavoriteProviderModel(c.req.param("providerId"), c.req.valid("json")), 201);
    })
    .delete("/api/providers/:providerId/model-favorites", zValidator("json", schemas.favoriteProviderModelSchema.pick({ modelId: true })), async (c) => {
      await runtime.removeFavoriteProviderModel(c.req.param("providerId"), c.req.valid("json").modelId);
      return c.json({ ok: true });
    })
    .post("/api/providers/:providerId/test", async (c) => {
      return c.json(await runtime.testProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/test-chat", zValidator("json", schemas.testChatProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const model = body.model;
      if (!model) {
        return c.json({ error: "model is required." }, 400);
      }
      return c.json(await runtime.testProviderChatByProfile(c.req.param("providerId"), model));
    })
    // ── Tokenize ──
    .post("/api/tokenize", zValidator("json", schemas.tokenizeSchema), async (c) => {
      const body = c.req.valid("json");
      const tokens = tokenizeText(body.text, body.model);
      return c.json({ tokens });
    })
  ;
}
