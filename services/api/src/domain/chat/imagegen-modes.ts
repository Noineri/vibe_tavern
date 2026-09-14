/**
 * @module chat/imagegen-modes
 *
 * IG-14 mode assembly (IMAGE_GENERATION_PLAN): the six generation-mode
 * recipes' prompt building. Design-locked flow: mode → Images-tab template
 * (service-prompt resolver: active-profile override → built-in asset) →
 * MacroEngine substitution over the chat context → the image-gen backend's
 * `generate` (the adapter feeds the result; this module owns ONLY the text).
 *
 * Context per mode (design doc):
 *   portrait / character     → character card fields ({{char}}, {{description}})
 *   user-persona             → the chat's persona ({{user}}, {{persona}})
 *   scene-background / scene-illustration → the last chat message
 *   free                     → the caller-provided raw prompt (required)
 *
 * RP-PROMPT SEPARATION (the plan's negative self-check): this module shares
 * NOTHING with the roleplay prompt assembly — it builds its own light
 * PromptVariableContext from raw stores (the regex-hook-service precedent,
 * not the full RP pipeline context), and nothing it produces is ever handed
 * to `assemblePrompt`. The generated image participates in RP context only
 * via the include-in-prompt opt-in (IG-18's vision-describe path), never
 * automatically.
 */

import { IMAGE_GENERATION_MODES, type ImageGenerationMode, type ServicePromptFieldKey } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { buildPromptVariableContext, createFullMacroEngine } from "@vibe-tavern/prompt-pipeline";
import { resolveServicePrompt } from "../service-prompts/service-prompt-resolver.js";

/** Mode → Images-tab template field (the IG-13 `images` family). */
export const IMAGE_GEN_MODE_TEMPLATE_FIELD: Record<ImageGenerationMode, ServicePromptFieldKey> = {
  [IMAGE_GENERATION_MODES.SceneBackground]: "image_scene_background",
  [IMAGE_GENERATION_MODES.Portrait]: "image_portrait",
  [IMAGE_GENERATION_MODES.Character]: "image_character",
  [IMAGE_GENERATION_MODES.UserPersona]: "image_user_persona",
  [IMAGE_GENERATION_MODES.SceneIllustration]: "image_scene_illustration",
  [IMAGE_GENERATION_MODES.Free]: "image_free",
};

/** The shared negative default (surfaced only for negative-capable
 *  providers — the consumption gate lives in the generate adapter). */
export const IMAGE_GEN_NEGATIVE_FIELD: ServicePromptFieldKey = "image_negative";

/** A well-formed generation request the mode module cannot satisfy (route →
 *  400 via the adapter's ImageGenValidationError mapping). */
export class ImageGenModeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenModeValidationError";
  }
}

/** The chat facts the templates substitute against — the pieces the adapter
 *  already resolved for its own chat lookup. */
export interface ImageGenModeChat {
  characterId: string;
  personaId: string | null;
  activeBranchId: string;
}

type ModeStores = Pick<StoreContainer, "db" | "characters" | "personas" | "messages">;

/** Built prompt text — positive and negative resolved in one pass so both
 *  ride the same macro context (a user-authored override may put {{char}}
 *  into either). */
export interface BuiltImageGenPrompts {
  prompt: string;
  /** Resolved negative default; the adapter decides whether to send it
   *  (capability gate) and lets the fine-tuning chip override it. */
  negativePrompt: string;
}

/** Load the mode's context and resolve the mode's template + the shared
 *  negative through the MacroEngine. The callerPrompt contract is the
 *  generate schema's (see image-gen-schema.ts): verbatim override on
 *  non-free modes, the REQUIRED payload on free. */
export async function buildImageGenPrompts(
  stores: ModeStores,
  chat: ImageGenModeChat,
  mode: ImageGenerationMode,
  callerPrompt: string | undefined,
): Promise<BuiltImageGenPrompts> {
  if (mode === IMAGE_GENERATION_MODES.Free && (callerPrompt === undefined || callerPrompt === "")) {
    // The design's free recipe is "custom size + raw prompt" — the raw
    // prompt IS the payload; there is nothing to template against.
    throw new ImageGenModeValidationError("mode 'free' requires the caller-provided prompt");
  }

  const [character, persona, lastMessage] = await Promise.all([
    stores.characters.getById(chat.characterId),
    resolvePersona(stores, chat.personaId),
    resolveLastMessage(stores, chat.activeBranchId),
  ]);

  // Light context — exactly the template surfaces (the regex-hook-service
  // precedent): names + card + persona + the last message. NOT the RP
  // pipeline context (presets/lore/summaries stay out of image prompts).
  const context = buildPromptVariableContext({
    character: character
      ? {
          name: character.name,
          description: character.description,
          personality: character.personalitySummary,
          scenario: character.defaultScenario,
        }
      : undefined,
    persona: persona
      ? {
          name: persona.name,
          description: persona.description,
          pronouns: persona.pronouns,
          pronounForms: persona.pronounForms,
        }
      : undefined,
    chat: { lastMessage },
  });
  const engine = createFullMacroEngine();
  const resolve = (text: string): string => engine.resolve(text, context);

  const { text: template } = await resolveServicePrompt(stores.db, IMAGE_GEN_MODE_TEMPLATE_FIELD[mode]);
  const { text: negative } = await resolveServicePrompt(stores.db, IMAGE_GEN_NEGATIVE_FIELD);

  if (mode === IMAGE_GENERATION_MODES.Free) {
    // The free template is a WRAPPER ("Depict exactly what the accompanying
    // prompt describes") — the caller text is the accompanying prompt, so
    // the composed payload is template + separator + raw prompt. The raw
    // prompt is NOT macro-substituted (it is already finished text).
    return { prompt: `${resolve(template).trim()}\n\n${callerPrompt}`, negativePrompt: resolve(negative).trim() };
  }

  // Non-free + callerPrompt = the chip's already-built edit — verbatim, no
  // re-substitution (substituting user-edited text could double-expand
  // braces the user deliberately kept).
  if (callerPrompt !== undefined) {
    return { prompt: callerPrompt, negativePrompt: resolve(negative).trim() };
  }

  return { prompt: resolve(template).trim(), negativePrompt: resolve(negative).trim() };
}

/** The persona the RP prompt itself would show (the prompt-assembly-service
 *  resolution mirrored): chat binding → default-for-new-chats → first row →
 *  none. Mirrored so {{user}}/{{persona}} resolve identically in image
 *  prompts and RP prompts for the same chat. */
async function resolvePersona(
  stores: ModeStores,
  personaId: string | null,
): Promise<Awaited<ReturnType<ModeStores["personas"]["getById"]>>> {
  if (personaId !== null) return stores.personas.getById(personaId);
  const all = await stores.personas.listAll();
  return stores.personas.getById(all.find((p) => p.defaultForNewChats)?.id ?? all[0]?.id ?? "");
}

/** {{lastChatMessage}}: the last NON-EMPTY message on the active branch, any
 *  role. Empty-content rows are skipped — image slots themselves carry empty
 *  content (the slot renders from its attachment), so a scene mode fired
 *  right after a generation must not template against an empty string. */
async function resolveLastMessage(stores: ModeStores, branchId: string): Promise<string | null> {
  const messages = await stores.messages.getMessages(branchId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.content.trim() !== "") return message.content;
  }
  return null;
}
