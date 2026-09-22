/**
 * @module chat/imagegen-modes
 *
 * IG-14 mode assembly (IMAGE_GENERATION_PLAN): the six generation-mode
 * recipes' prompt building. Design-locked flow: mode → Images-tab template
 * (the (row × family) variant resolver: custom row → family canon → prose
 * canon, IPT Waves 1–2) → MacroEngine substitution over the chat context → the image-gen backend's
 * `generate` (the adapter feeds the result; this module owns ONLY the text).
 *
 * IPT Wave 2 assembly: the adapter resolves the profile's prompt family
 * (manual pin → fresh auto → prose, `prompt-family-resolution.ts`) and
 * passes it in — templates, the negative row, and the assist addendum all
 * ride it. The quality layer joins ONLY on the profile's explicit toggle,
 * as its own trailing line group (never interleaved into scene text).
 *
 * Context per mode (design doc):
 *   portrait / character     → character card fields ({{char}}, {{description}})
 *   selfie / avatar          → character card fields too (IPT Wave 0 — the
 *                             templates pick what they need; no per-mode
 *                             branch exists in the builder)
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

import { IMAGE_GENERATION_MODES, IMAGE_PROMPT_DEFAULT_FAMILY, imagePromptCanonFamily, type ImageGenerationMode, type ImagePromptFamilyId, type ImagePromptOverridesMap } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { buildPromptVariableContext, createFullMacroEngine } from "@vibe-tavern/prompt-pipeline";
import { resolveActiveImagePromptOverrides, resolveImagePromptVariant } from "../imagegen/prompt-variant-resolver.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

/** IPT Wave 2: the family-driven assembly knobs the adapter passes in
 *  (both default to the pre-IPT behavior — unpinned profiles stay
 *  byte-identical to the interim baseline). */
export interface ImageGenModePromptOptions {
  /** The resolved prompt family (manual pin → fresh auto → prose). Free
   *  mode stays family-neutral inside the resolver regardless. */
  promptFamily?: ImagePromptFamilyId;
  /** The profile-level quality-layer toggle — the tag-dialect quality
   *  block joins the SERVER-built prompt only when explicitly on. */
  qualityLayerEnabled?: boolean;
}

/** The IG-15 assist system prompt: the extraction core plus the resolved
 *  family's dialect addendum (`image-assist.{family}.md`; prose IS the base
 *  dialect and has no addendum). Unpinned profiles get the core alone —
 *  byte-identical to the interim service-prompt resolution. The images
 *  family's service-prompt rows are unread legacy from here on (IPT Waves
 *  1–2; pane swap Wave 4, field retirement Wave 6). */
export async function composeAssistInstruction(family: ImagePromptFamilyId): Promise<string> {
  const core = await loadPromptAsset("image-assist.md");
  if (family === IMAGE_PROMPT_DEFAULT_FAMILY) return core;
  const addendum = await loadPromptAsset(`image-assist.${family}.md`);
  // Both parts trimmed: asset files carry trailing newlines, and the mode
  // module's end-trim would otherwise leave a triple break between them.
  return `${core.trim()}\n\n${addendum.trim()}`;
}

/** IF-1c quality layer: the family's canon block
 *  (`image-quality.{family}.md`) or the ACTIVE profile's custom quality
 *  text (the (mode × family) cell's qualityText), ONLY when the profile
 *  toggled the layer on AND the family authors one (prose checkpoints
 *  have no quality layer — no universal fallback). Returns "" = no block. */
async function resolveQualityBlock(
  mode: ImageGenerationMode,
  family: ImagePromptFamilyId,
  enabled: boolean,
  overrides: ImagePromptOverridesMap,
): Promise<string> {
  if (!enabled) return "";
  const canonFamily = imagePromptCanonFamily(family, "quality", mode);
  if (canonFamily === undefined) return "";
  const customQuality = overrides[`${mode}|${family}`]?.qualityText;
  if (customQuality !== null && customQuality !== undefined && customQuality.trim() !== "") {
    return customQuality.trim();
  }
  return (await loadPromptAsset(`image-quality.${canonFamily}.md`)).trim();
}

/** Appends the quality block as its own trailing line group (the plan's
 *  never-interleaved rule). */
function withQualityBlock(prompt: string, block: string): string {
  return block === "" ? prompt : `${prompt}\n\n${block}`;
}

/** A well-formed generation request the mode module cannot satisfy (route →
 *  400 via the adapter's ImageGenValidationError mapping). */
export class ImageGenModeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenModeValidationError";
  }
}

/** The chat facts the templates substitute against — the pieces the adapter
 *  already resolved for its own chat lookup. `anchorMessageId` (MR-13):
 *  the message the user opened the generation menu on — when present it
 *  REPLACES the branch tail as the "current moment" both for
 *  `{{lastChatMessage}}` and the assist digest (the button lives on every
 *  character message, so the depicted moment is the anchored one, not the
 *  latest). Absent → tail behavior (unchanged for legacy callers). */
export interface ImageGenModeChat {
  characterId: string;
  personaId: string | null;
  activeBranchId: string;
  anchorMessageId?: string;
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
  options?: ImageGenModePromptOptions,
): Promise<BuiltImageGenPrompts> {
  if (mode === IMAGE_GENERATION_MODES.Free && (callerPrompt === undefined || callerPrompt === "")) {
    // The design's free recipe is "custom size + raw prompt" — the raw
    // prompt IS the payload; there is nothing to template against.
    throw new ImageGenModeValidationError("mode 'free' requires the caller-provided prompt");
  }

  const [character, persona, lastMessage] = await Promise.all([
    stores.characters.getById(chat.characterId),
    resolvePersona(stores, chat.personaId),
    resolveContextMessage(stores, chat.activeBranchId, chat.anchorMessageId),
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

  // IPT Waves 1–2: template + negative resolve through the variant chain
  // (custom row → family canon → prose canon) under the ADAPTER-RESOLVED
  // family (manual pin → fresh auto → prose). Unpinned profiles resolve
  // prose — byte-identical to the interim service-prompt resolution.
  const family = options?.promptFamily ?? IMAGE_PROMPT_DEFAULT_FAMILY;
  // IF-1c: the custom tier of EVERY row (template / negative / quality)
  // comes from the ACTIVE image prompt profile, resolved once per build.
  // No pointer / dangling pointer / the read-only Default → the empty map,
  // which is pure canon — byte-identical to the pre-IF-1 chain for an
  // install that never customized anything.
  const overrides = await resolveActiveImagePromptOverrides(stores.db);
  const { text: template } = await resolveImagePromptVariant({ rowKey: mode, family }, overrides);
  const { text: negative } = await resolveImagePromptVariant({ rowKey: "negative", family }, overrides);
  // IPT Wave 2 quality layer — pre-resolved so every server-build return
  // below appends the same trailing block; verbatim/free paths never
  // append (finished user text is not a template surface).
  const qualityBlock = await resolveQualityBlock(mode, family, options?.qualityLayerEnabled === true, overrides);

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
  // the instruction (the extraction core + the family's dialect addendum,
  // macro-resolved like every other template) + the scene digest + the RAW
  // mode template (placeholders intact — the model resolves them against the
  // digest); its output IS the image prompt body, and the macro pass then
  // resolves any placeholder the model left in place.
  if (assist !== undefined) {
    const instruction = await composeAssistInstruction(family);
    const refined = (await assist(resolve(instruction).trim(), buildAssistUserPayload(template, contextDigest(character, persona, lastMessage)))).trim();
    if (refined === "") {
      throw new ImageGenModeValidationError("LLM assist returned an empty prompt");
    }
    return { prompt: withQualityBlock(resolve(refined).trim(), qualityBlock), negativePrompt: resolve(negative).trim() };
  }

  return { prompt: withQualityBlock(resolve(template).trim(), qualityBlock), negativePrompt: resolve(negative).trim() };
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

/** {{lastChatMessage}} (MR-13): the depicted message — the ANCHORED one when
 *  the request carries an anchor (the generation button sits on each
 *  character message, so "this moment" is the message the user clicked),
 * otherwise the last NON-EMPTY message on the active branch. The walk skips
 * empty-content rows from the anchor (or tail) backward — image slots
 * themselves carry empty content (the slot renders from its attachment),
 * so a scene mode anchored on (or after) a slot must not template against an
 * empty string. An anchor not found on the active branch falls back to the
 * tail walk (defensive; the adapter validates chat membership). */
async function resolveContextMessage(
  stores: ModeStores,
  branchId: string,
  anchorMessageId: string | undefined,
): Promise<string | null> {
  const messages = await stores.messages.getMessages(branchId);
  let startIndex = messages.length - 1;
  if (anchorMessageId !== undefined) {
    const anchorIndex = messages.findIndex((m) => m.id === anchorMessageId);
    if (anchorIndex >= 0) startIndex = anchorIndex;
  }
  for (let i = startIndex; i >= 0; i -= 1) {
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
  if (lastMessage !== null) lines.push(`Message to depict: ${lastMessage}`);
  return lines.join("\n");
}

/** The assist call's user message: the digest + the RAW mode template (the
 *  task). The instruction (system) comes from the image_assist template. */
function buildAssistUserPayload(rawTemplate: string, digest: string): string {
  return `Scene facts:\n${digest}\n\nImage task (expand into one finished image prompt; the placeholders refer to the facts above):\n${rawTemplate}`;
}
