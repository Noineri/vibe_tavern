import type { ServicePromptFieldKey } from "@vibe-tavern/domain";

/**
 * Server-side key → asset-file map for the base service prompts.
 *
 * `scene_schema` is intentionally pinned to the JSON default. The existing
 * mode machinery (`ai-assistant-modes.ts: scene_schema` with
 * `formatPromptFiles: { json, xml }`) selects the XML variant only on
 * the DEFAULT tier when `promptFormat === "xml"`; this registry drives the
 * profile-override tier, which is format-agnostic. Overrides always win above
 * this map.
 */
export const SERVICE_PROMPT_ASSET_FILES: Record<ServicePromptFieldKey, string> = {
  // assistant (12)
  script: "script-ai-prompt.md",
  dice_script: "dice-script-ai-prompt.md",
  lore_entry: "lore-entry-ai-prompt.md",
  lore_keys: "lore-keys-ai-prompt.md",
  chat_impersonate: "chat-impersonate-ai-prompt.md",
  md_import: "md-import-prompt.md",
  vision_describe: "vision-describe-ai-prompt.md",
  scene_schema: "scene-schema-json.md",
  scene_rules: "scene-rules.md",
  message_edit: "message-edit-ai-prompt.md",
  message_merge: "message-merge-ai-prompt.md",
  message_tts_annotate: "message-tts-annotate-ai-prompt.md",
  regex: "regex-ai-prompt.md",
  // summary (1)
  summary: "summary-ai-prompt.md",
  // insights (4)
  objective_generate: "objective-generate.md",
  objective_generate_goals: "objective-generate-goals.md",
  objective_check: "objective-check.md",
  scene_generate: "scene-generate.md",
  // bases (5)
  coauthor_base: "coauthor/base.md",
  copilot_base: "experience-copilot/base.md",
  copilot_user_flow: "experience-copilot/user-flow.md",
  interactive_rules: "interactive-rules.md",
  interactive_visual: "interactive-visual.md",
  // images (8) — per-mode base templates + the shared negative default
  // (IG-13) + the LLM-assist quiet pre-pass instruction (IG-15). Plain
  // prompt prose, no markdown headers: unlike the LLM system prompts
  // above, the mode files are prompt PAYLOADS for image models — a header
  // line would be sent verbatim and waste prompt budget; the negative
  // default is a bare tag list for the same reason. image_assist is an LLM
  // system instruction but keeps the same convention (short prose).
  image_scene_background: "image-scene-background.md",
  image_portrait: "image-portrait.md",
  image_character: "image-character.md",
  image_user_persona: "image-user-persona.md",
  image_scene_illustration: "image-scene-illustration.md",
  image_free: "image-free.md",
  image_negative: "image-negative.md",
  image_assist: "image-assist.md",
} as const satisfies Record<ServicePromptFieldKey, string>;

export function getServicePromptAssetFile(key: ServicePromptFieldKey): string {
  return SERVICE_PROMPT_ASSET_FILES[key];
}
