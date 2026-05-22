import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { createDebugRoutes } from "./debug.js";
import { createChatRoutes } from "./chat.js";
import { createCharacterRoutes } from "./character.js";
import { createPersonaRoutes } from "./persona.js";
import { createLorebookRoutes } from "./lorebook.js";
import { createScriptRoutes } from "./script.js";
import { createProviderRoutes } from "./provider.js";
import { createPresetRoutes } from "./preset.js";
import { createImportRoutes } from "./import.js";
import { createAssetRoutes } from "./asset.js";

export type { RuntimeApi } from "./types.js";

export function createApiRouter(runtime: RuntimeApi) {
  return new Hono()
    .route("/", createDebugRoutes(runtime))
    .route("/", createChatRoutes(runtime))
    .route("/", createCharacterRoutes(runtime))
    .route("/", createPersonaRoutes(runtime))
    .route("/", createLorebookRoutes(runtime))
    .route("/", createScriptRoutes(runtime))
    .route("/", createProviderRoutes(runtime))
    .route("/", createPresetRoutes(runtime))
    .route("/", createImportRoutes(runtime))
    .route("/", createAssetRoutes(runtime))
  ;
}

export type AppType = ReturnType<typeof createApiRouter>;
