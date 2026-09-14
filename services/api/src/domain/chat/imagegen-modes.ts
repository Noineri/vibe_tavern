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

/** The quiet pre-pass instruction (IG-15) — the images family's LLM-assist
 *  system prompt. */
export const IMAGE_GEN_ASSIST_FIELD: ServicePromptFieldKey = "image_assist";

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

/** IG-15 quiet pre-pass seam: run ONE non-streaming LLM completion with the
 *  given system + user text and return its output. The adapter wires this to
 *  the image-gen profile's chosen LLM provider profile + model through
 *  `nonstreamingProviderExecute` (the chat-summary seam, profile/model
 *  resolved from the image-gen profile's saved assist fields). Failures
 *  PROPAGATE — the generation fails with the normalized provider error
 *  instead of silently falling through to the unrefined prompt. */
export type ImageGenAssistRunner = (system: string, user: string) => Promise<string>;

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
 *  non-free modes, the REQUIRED payload on free.
 *
 *  IG-15 assist (`assist` provided): on the one path where the SERVER builds
 *  the prompt from the scene (non-free mode, no caller prompt), the quiet
 *  LLM pre-pass writes the image prompt body FIRST — the design's order
 *  ("the model writes the image prompt from the scene, then substitutes
 *  macros") — and the macro engine then resolves whatever placeholders the
 *  model left in its output. The verbatim paths are exempt by design: a
 *  caller prompt (the chip's built edit, free mode's raw payload) is
 *  finished user-authored text, and rewriting it would break the IG-14
 *  verbatim contract. */
export async function buildImageGenPrompts(
  stores: ModeStores,
  chat: ImageGenModeChat,
  mode: ImageGenerationMode,
  callerPrompt: string | undefined,
  assist?: ImageGenAssistRunner,
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
  // braces the user deliberately kept). Assist does not apply: the prompt is
  // finished text, not a scene to build.
  if (callerPrompt !== undefined) {
    return { prompt: callerPrompt, negativePrompt: resolve(negative).trim() };
  }

  // The server-side scene build — the assist path. The quiet call receives
  // the instruction (the images family's image_assist template, macro-
  // resolved like every other family member) + the scene digest + the RAW
  // mode template (placeholders intact — the model resolves them against the
  // digest); its output IS the image prompt body, and the macro pass then
  // resolves any placeholder the model left in place.
  if (assist !== undefined) {
    const { text: instruction } = await resolveServicePrompt(stores.db, IMAGE_GEN_ASSIST_FIELD);
    const refined = (await assist(resolve(instruction).trim(), buildAssistUserPayload(template, contextDigest(character, persona, lastMessage)))).trim();
    if (refined === "") {
      throw new ImageGenModeValidationError("LLM assist returned an empty prompt");
    }
    return { prompt: resolve(refined).trim(), negativePrompt: resolve(negative).trim() };
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

// ─── IG-15 quiet pre-pass helpers ─────────────────────────────────────────────

type ModeCharacter = Awaited<ReturnType<ModeStores["characters"]["getById"]>>;
type ModePersona = Awaited<ReturnType<ModeStores["personas"]["getById"]>>;

/** The scene facts for the assist call, human-readable — the same sources the
 *  macro context substitutes from (card + persona + last message), rendered
 *  as labeled lines so the LLM can resolve the template's placeholders
 *  against them. Absent pieces simply drop out; nothing is truncated. */
function contextDigest(character: ModeCharacter, persona: ModePersona, lastMessage: string | null): string {
  const lines: string[] = [];
  if (character) {
    lines.push(`Character — ${character.name}`);
    if (character.description != null && character.description.trim() !== "") lines.push(`Description: ${character.description}`);
    if (character.personalitySummary != null && character.personalitySummary.trim() !== "") lines.push(`Personality: ${character.personalitySummary}`);
    if (character.defaultScenario != null && character.defaultScenario.trim() !== "") lines.push(`Scenario: ${character.defaultScenario}`);
  }
  if (persona) {
    lines.push(`User persona — ${persona.name}`);
    if (persona.description.trim() !== "") lines.push(`Description: ${persona.description}`);
  }
  if (lastMessage !== null) lines.push(`Last chat message: ${lastMessage}`);
  return lines.join("\n");
}

/** The assist call's user message: the digest + the RAW mode template (the
 *  task). The instruction (system) comes from the image_assist template. */
function buildAssistUserPayload(rawTemplate: string, digest: string): string {
  return `Scene facts:\n${digest}\n\nImage task (expand into one finished image prompt; the placeholders refer to the facts above):\n${rawTemplate}`;
}
