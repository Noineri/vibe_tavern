import { Hono } from "hono";
import type { RuntimeApi } from "../api/contract/runtime-api.js";
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
import { createSettingsRoutes } from "./settings.js";

export type { RuntimeApi } from "../api/contract/runtime-api.js";

export function createApiRouter(runtime: RuntimeApi) {
  return new Hono()
    .route("/", createDebugRoutes({ bootstrap: runtime.bootstrap }))
    .route("/", createChatRoutes(runtime.chat))
    .route("/", createCharacterRoutes(runtime.character))
    .route("/", createPersonaRoutes(runtime.persona))
    .route("/", createLorebookRoutes(runtime.lorebook))
    .route("/", createScriptRoutes(runtime.script))
    .route("/", createProviderRoutes(runtime.provider))
    .route("/", createPresetRoutes(runtime.preset))
    .route("/", createImportRoutes(runtime.importExport))
    .route("/", createAssetRoutes(runtime.asset))
    .route("/", createSettingsRoutes({ ...runtime.settings, ...runtime.mobileAccess }))
  ;
}

export type AppType = ReturnType<typeof createApiRouter>;
