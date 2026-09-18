/**
 * @module routes/image-gen
 *
 * Image-gen profile CRUD + probe/models/samplers + generate + gallery
 * promotion routes (IMAGE_GENERATION_PLAN IG-8). Mirrors routes/stt.ts: the
 * same envelope shapes and the same error ladder — profile misses surface as
 * 404, config/validation problems as 400, and normalized upstream failures as
 * 400 (4xx upstream) or 502 (5xx/transport). The locked route list
 * (IMAGE_GENERATION_DESIGN "API / routes"):
 *   GET    /api/image-gen/profiles/all
 *   GET    /api/image-gen/profiles/:id
 *   POST   /api/image-gen/profiles
 *   PATCH  /api/image-gen/profiles/:id
 *   DELETE /api/image-gen/profiles/:id
 *   POST   /api/image-gen/profiles/:id/probe
 *   GET    /api/image-gen/profiles/:id/models
 *   GET    /api/image-gen/profiles/:id/samplers        (capability-gated)
 *   GET    /api/image-gen/profiles/:id/schedulers       (dialect-gated: A1111 + ComfyUI, PG-3/CG-A3)
 *   GET    /api/image-gen/profiles/:id/progress        (capability-gated, PG-2)
 *   POST   /api/image-gen/profiles/:id/interrupt       (capability-gated, PG-2)
 *   POST   /api/image-gen/draft/models                 (shared fetch-by-endpoint)
 *   POST   /api/chats/:chatId/image-gen/generate       (image message slot)
 *   POST   /api/image-gen/attachments/:assetId/promote-to-gallery
 *   GET    /api/image-gen/profiles/:id/model-favorites  (IG-12b)
 *   POST   /api/image-gen/profiles/:id/model-favorites
 *   DELETE /api/image-gen/profiles/:id/model-favorites
 *   GET    /api/image-gen/profiles/:id/model-settings   (IG-12b)
 *   GET    /api/image-gen/profiles/:id/model-settings/:modelId
 *   PUT    /api/image-gen/profiles/:id/model-settings/:modelId
 *   DELETE /api/image-gen/profiles/:id/model-settings/:modelId
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

import type { ImageGenRuntimeApi } from "../contract/runtime-api.js";
import { ImageGenNotFoundError, ImageGenTimeoutError, ImageGenValidationError } from "../adapters/image-gen-adapter.js";
import { ProviderExecutionError } from "../../infrastructure/ai/provider-execution-types.js";
import { ImageGenBackendNotRegisteredError, ImageGenUnknownBackendError } from "../../domain/imagegen/imagegen-registry.js";
import {
  OpenRouterImageGenConfigError,
  OpenRouterImageGenError,
  OpenRouterImageGenSizeError,
} from "../../domain/imagegen/backends/openrouter.js";
import {
  OpenAiImagesConfigError,
  OpenAiImagesError,
  OpenAiImagesSizeError,
} from "../../domain/imagegen/backends/openai-images.js";
import {
  A1111ImageGenConfigError,
  A1111ImageGenError,
  A1111ImageGenSizeError,
} from "../../domain/imagegen/backends/a1111.js";
import {
  ComfyImageGenConfigError,
  ComfyImageGenError,
  ComfyImageGenSizeError,
} from "../../domain/imagegen/backends/comfyui.js";

/** Upstream failures with an HTTP status: a 4xx upstream is the caller's
 *  problem (400), anything else is gateway-class (502) — the STT ladder. */
function upstreamStatus(status: number | undefined): 400 | 502 {
  return status !== undefined && status >= 400 && status < 500 ? 400 : 502;
}

/** Map a thrown backend error onto the route ladder (the STT draft-route
 *  convention): config/size problems are the caller's (400), upstream
 *  failures gateway-class (502, or 400 for a 4xx upstream). Null = not a
 *  backend error — rethrow for Hono's 500 fallback. Shared by the
 *  profile-bound models/samplers routes and the draft/generate routes. */
function backendErrorResponse(error: unknown): { body: { error: string }; status: 400 | 502 } | null {
  if (
    error instanceof OpenRouterImageGenConfigError ||
    error instanceof OpenAiImagesConfigError ||
    error instanceof A1111ImageGenConfigError ||
    error instanceof ComfyImageGenConfigError ||
    error instanceof OpenRouterImageGenSizeError ||
    error instanceof OpenAiImagesSizeError ||
    error instanceof A1111ImageGenSizeError ||
    error instanceof ComfyImageGenSizeError
  ) {
    return { body: { error: error.message }, status: 400 };
  }
  if (
    error instanceof OpenRouterImageGenError ||
    error instanceof OpenAiImagesError ||
    error instanceof A1111ImageGenError ||
    error instanceof ComfyImageGenError
  ) {
    return { body: { error: error.message }, status: upstreamStatus(error.status) };
  }
  return null;
}

export function createImageGenRoutes(runtime: ImageGenRuntimeApi) {
  return new Hono()
    // ── Profile CRUD ──────────────────────────────────────────────────────
    .get("/api/image-gen/profiles/all", async (c) => {
      return c.json(await runtime.listImageGenProfiles());
    })
    .get("/api/image-gen/profiles/:id", async (c) => {
      const profile = await runtime.getImageGenProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(profile);
    })
    .post("/api/image-gen/profiles", zValidator("json", schemas.createImageGenProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createImageGenProfile(body), 201);
    })
    .patch("/api/image-gen/profiles/:id", zValidator("json", schemas.updateImageGenProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const updated = await runtime.updateImageGenProfile(c.req.param("id"), body);
      if (!updated) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(updated);
    })
    .delete("/api/image-gen/profiles/:id", async (c) => {
      await runtime.deleteImageGenProfile(c.req.param("id"));
      return c.json({ ok: true });
    })
    // ── Probe (probe-only validation — no test-generate, owner) ──────────
    .post("/api/image-gen/profiles/:id/probe", async (c) => {
      const result = await runtime.probeImageGenProfile(c.req.param("id"), c.req.raw.signal);
      if (!result) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(result);
    })
    // ── Live model discovery (picker data source) ─────────────────────────
    .get("/api/image-gen/profiles/:id/models", async (c) => {
      try {
        const models = await runtime.listImageGenProfileModels(c.req.param("id"), c.req.raw.signal);
        if (models === null) return c.json({ error: "Image-gen profile not found" }, 404);
        return c.json(models);
      } catch (error) {
        // The saved-profile twin of the draft route's ladder (the STT
        // convention): a picker data source maps upstream failures, never 500s.
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Extensions (A1111-dialect feature detection — the ADetailer probe) ──
    .get("/api/image-gen/profiles/:id/extensions", async (c) => {
      try {
        const extensions = await runtime.listImageGenProfileExtensions(c.req.param("id"), c.req.raw.signal);
        if (extensions === null) {
          // Unknown profile vs unsupported backend are indistinguishable from
          // null alone — resolve the profile to pick the right status.
          const profile = await runtime.getImageGenProfile(c.req.param("id"));
          if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
          return c.json({ error: "extension listing not supported" }, 400);
        }
        return c.json(extensions);
      } catch (error) {
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Samplers (capability-gated) ───────────────────────────────────────
    .get("/api/image-gen/profiles/:id/samplers", async (c) => {
      try {
        const samplers = await runtime.listImageGenProfileSamplers(c.req.param("id"), c.req.raw.signal);
        if (samplers === null) {
          // Unknown profile vs unsupported backend are indistinguishable from
          // null alone — resolve the profile to pick the right status.
          const profile = await runtime.getImageGenProfile(c.req.param("id"));
          if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
          return c.json({ error: "sampler listing not supported" }, 400);
        }
        return c.json(samplers);
      } catch (error) {
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Schedulers / schedule type (dialect-gated, PG-3) ─────────────
    .get("/api/image-gen/profiles/:id/schedulers", async (c) => {
      try {
        const schedulers = await runtime.listImageGenProfileSchedulers(c.req.param("id"), c.req.raw.signal);
        if (schedulers === null) {
          // Unknown profile vs unsupported backend are indistinguishable from
          // null alone — resolve the profile to pick the right status.
          const profile = await runtime.getImageGenProfile(c.req.param("id"));
          if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
          return c.json({ error: "scheduler listing not supported" }, 400);
        }
        return c.json(schedulers);
      } catch (error) {
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Live progress (capability-gated, PG-2) ───────────────────────
    .get("/api/image-gen/profiles/:id/progress", async (c) => {
      try {
        const snapshot = await runtime.getImageGenProfileProgress(c.req.param("id"), c.req.raw.signal);
        if (snapshot === null) {
          // Unknown profile vs unsupported backend (the samplers ladder).
          const profile = await runtime.getImageGenProfile(c.req.param("id"));
          if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
          return c.json({ error: "live progress not supported" }, 400);
        }
        return c.json(snapshot);
      } catch (error) {
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Interrupt (capability-gated, PG-2) ─────────────────────────────
    .post("/api/image-gen/profiles/:id/interrupt", async (c) => {
      try {
        const sent = await runtime.interruptImageGenProfile(c.req.param("id"), c.req.raw.signal);
        if (sent === null) {
          const profile = await runtime.getImageGenProfile(c.req.param("id"));
          if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
          return c.json({ error: "interrupt not supported" }, 400);
        }
        return c.body(null, 204);
      } catch (error) {
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Shared fetch-by-endpoint model listing (draft twin) ───────────────
    .post("/api/image-gen/draft/models", zValidator("json", schemas.draftImageGenModelsSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        const models = await runtime.draftListImageGenModels(body);
        if (models === null) return c.json({ error: "model listing not supported" }, 400);
        return c.json(models);
      } catch (error) {
        if (error instanceof ImageGenUnknownBackendError || error instanceof ImageGenBackendNotRegisteredError) {
          return c.json({ error: error.message }, 400);
        }
        const mapped = backendErrorResponse(error);
        if (mapped) return c.json(mapped.body, mapped.status);
        throw error;
      }
    })
    // ── Generate (image message slot) ─────────────────────────────────────
    .post(
      "/api/chats/:chatId/image-gen/generate",
      zValidator("json", schemas.generateImageGenSchema),
      async (c) => {
        const body = c.req.valid("json");
        try {
          // The route's abort signal IS the generation signal (the
          // ai-assistant abort contract; no timeout constants ship in code).
          return c.json(await runtime.generateImageGen(c.req.param("chatId"), body, c.req.raw.signal));
        } catch (error) {
          if (error instanceof ImageGenNotFoundError) {
            return c.json({ error: error.message }, 404);
          }
          if (error instanceof ImageGenValidationError) {
            return c.json({ error: error.message }, 400);
          }
          if (error instanceof ImageGenUnknownBackendError || error instanceof ImageGenBackendNotRegisteredError) {
            return c.json({ error: error.message }, 400);
          }
          if (error instanceof ImageGenTimeoutError) {
            return c.json({ error: error.message }, 504);
          }
          // IG-15: the LLM-assist quiet call failed upstream — the executor
          // already normalized the message at its boundary; surface it with
          // the route's `{error: string}` shape (same status the app-level
          // handler uses for ProviderExecutionError).
          if (error instanceof ProviderExecutionError) {
            return c.json({ error: `LLM assist failed: ${error.message}` }, 502);
          }
          const mapped = backendErrorResponse(error);
          if (mapped) return c.json(mapped.body, mapped.status);
          throw error;
        }
      },
    )
    // ── Gallery promotion (attachment → character gallery) ────────────────
    .post(
      "/api/image-gen/attachments/:assetId/promote-to-gallery",
      zValidator("json", schemas.promoteImageGenAttachmentSchema),
      async (c) => {
        try {
          const body = c.req.valid("json");
          return c.json(
            await runtime.promoteImageGenAttachmentToGallery(c.req.param("assetId"), body.characterId),
            201,
          );
        } catch (error) {
          if (error instanceof ImageGenNotFoundError) {
            return c.json({ error: error.message }, 404);
          }
          // Gallery writes share the asset-service upload gates (mime/size) —
          // a rejection there is a caller problem, not a 500.
          if (error instanceof Error && /Unsupported attachment type|Attachment too large/.test(error.message)) {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      },
    )
    // ── Model favorites (IG-12b — the provider model-favorites twin) ────
    .get("/api/image-gen/profiles/:id/model-favorites", async (c) => {
      const rows = await runtime.listImageGenModelFavorites(c.req.param("id"));
      if (rows === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(rows);
    })
    .post("/api/image-gen/profiles/:id/model-favorites", zValidator("json", schemas.favoriteImageGenModelSchema), async (c) => {
      const row = await runtime.addImageGenModelFavorite(c.req.param("id"), c.req.valid("json"));
      if (row === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(row, 201);
    })
    .delete("/api/image-gen/profiles/:id/model-favorites", zValidator("json", schemas.favoriteImageGenModelSchema.pick({ modelId: true })), async (c) => {
      const removed = await runtime.removeImageGenModelFavorite(c.req.param("id"), c.req.valid("json").modelId);
      if (removed === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json({ ok: true });
    })
    // ── Per-model settings overlay (IG-12b — the provider twin split) ──
    .get("/api/image-gen/profiles/:id/model-settings", async (c) => {
      const rows = await runtime.listImageGenModelSettings(c.req.param("id"));
      if (rows === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(rows);
    })
    .get("/api/image-gen/profiles/:id/model-settings/:modelId", async (c) => {
      // Null alone cannot distinguish "unknown profile" from "model has no
      // overlay yet" — resolve the profile to pick the status (the samplers
      // ladder).
      const row = await runtime.getImageGenModelSettings(c.req.param("id"), c.req.param("modelId"));
      if (row === null) {
        const profile = await runtime.getImageGenProfile(c.req.param("id"));
        if (!profile) return c.json({ error: "Image-gen profile not found" }, 404);
        return c.json(null);
      }
      return c.json(row);
    })
    .put("/api/image-gen/profiles/:id/model-settings/:modelId", zValidator("json", schemas.upsertImageGenModelSettingsSchema), async (c) => {
      const body = c.req.valid("json");
      const row = await runtime.upsertImageGenModelSettings(
        c.req.param("id"),
        c.req.param("modelId"),
        body.settings,
        body.samplerSetId,
      );
      if (row === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json(row);
    })
    .delete("/api/image-gen/profiles/:id/model-settings/:modelId", async (c) => {
      const removed = await runtime.deleteImageGenModelSettings(c.req.param("id"), c.req.param("modelId"));
      if (removed === null) return c.json({ error: "Image-gen profile not found" }, 404);
      return c.json({ ok: true });
    })
    // ── Named image-gen sampler sets (IG-CF15 — the sampler_sets LS-5 twin;
    //    a GLOBAL library, no profile scoping) ──
    .get("/api/image-gen/sampler-sets", async (c) => {
      return c.json(await runtime.listImageGenSamplerSets());
    })
    .post("/api/image-gen/sampler-sets/import", zValidator("json", schemas.importImageGenSamplerSetSchema), async (c) => {
      return c.json(await runtime.importImageGenSamplerSet(c.req.valid("json")));
    })
    .post("/api/image-gen/sampler-sets", zValidator("json", schemas.createImageGenSamplerSetSchema), async (c) => {
      return c.json(await runtime.createImageGenSamplerSet(c.req.valid("json")));
    })
    .patch("/api/image-gen/sampler-sets/:setId", zValidator("json", schemas.updateImageGenSamplerSetSchema), async (c) => {
      return c.json(await runtime.updateImageGenSamplerSet(c.req.param("setId"), c.req.valid("json")));
    })
    .delete("/api/image-gen/sampler-sets/:setId", async (c) => {
      await runtime.deleteImageGenSamplerSet(c.req.param("setId"));
      return c.json({ ok: true });
    });
}
