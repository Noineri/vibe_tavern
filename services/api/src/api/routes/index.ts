import { Hono } from "hono";
import type { RuntimeApi } from "../contract/runtime-api.js";
import { createDebugRoutes } from "./debug.js";
import { createChatRoutes } from "./chat.js";
import { createCharacterRoutes } from "./character.js";
import { createPersonaRoutes } from "./persona.js";
import { createLorebookRoutes } from "./lorebook.js";
import { createScriptRoutes } from "./script.js";
import { createRegexRoutes } from "./regex.js";
import { createTtsRoutes } from "./tts.js";
import { createSttRoutes } from "./stt.js";
import { createServicePromptRoutes } from "./service-prompts.js";
import { createProviderRoutes } from "./provider.js";
import { createProxyRoutes } from "./proxy.js";
import { createPresetRoutes } from "./preset.js";
import { createImportRoutes } from "./import.js";
import { createAssetRoutes } from "./asset.js";
import { createSettingsRoutes } from "./settings.js";
import { createMobileAccessRoutes } from "./mobile-access.js";
import { createInsightsRoutes } from "./insights.js";
import { createRuntimeRoutes } from "./runtime.js";
import { createFsRoutes } from "./fs.js";
import { createCoauthorSkillRoutes } from "./coauthor-skill.js";
import { createCopilotSkillRoutes } from "./copilot-skill.js";
import { createCopilotProfileRoutes } from "./copilot-profile.js";
import { createDiceRoutes } from "./dice.js";
import { createExperienceRoutes } from "./experience.js";
import { createExperienceCopilotRoutes } from "./experience-copilot.js";

export type { RuntimeApi } from "../contract/runtime-api.js";

export function createApiRouter(runtime: RuntimeApi) {
  return new Hono()
    .route("/", createDebugRoutes({ bootstrap: runtime.bootstrap }))
    .route("/", createChatRoutes(runtime.chat))
    .route("/", createCharacterRoutes(runtime.character))
    .route("/", createPersonaRoutes(runtime.persona))
    .route("/", createLorebookRoutes(runtime.lorebook))
    .route("/", createScriptRoutes(runtime.script))
    .route("/", createServicePromptRoutes(runtime.servicePrompts))
    .route("/", createRegexRoutes(runtime.regex))
    .route("/", createTtsRoutes(runtime.tts))
    .route("/", createSttRoutes(runtime.stt))
    .route("/", createProviderRoutes(runtime.provider))
    .route("/", createProxyRoutes(runtime.proxy))
    .route("/", createPresetRoutes(runtime.preset))
    .route("/", createImportRoutes(runtime.importExport))
    .route("/", createAssetRoutes(runtime.asset))
    .route("/", createSettingsRoutes(runtime.settings))
    .route("/", createMobileAccessRoutes(runtime.mobileAccess))
    .route("/", createInsightsRoutes(runtime.insights))
    .route("/", createDiceRoutes(runtime.dice))
    .route("/", createExperienceRoutes(runtime.experience))
    .route("/", createExperienceCopilotRoutes(runtime.experienceCopilot))
    .route("/", createRuntimeRoutes())
    .route("/", createFsRoutes())
    .route("/", createCoauthorSkillRoutes(runtime.coauthorSkills))
    .route("/", createCopilotSkillRoutes(runtime.copilotSkills))
    .route("/", createCopilotProfileRoutes(runtime.copilotProfiles))
  ;
}

export type AppType = ReturnType<typeof createApiRouter>;
