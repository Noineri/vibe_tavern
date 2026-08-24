import { REGEX_PLACEMENT, regexApplyTargetOf } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import {
  applyRegexLayer,
  buildPromptVariableContext,
  createFullMacroEngine,
  filterRegexPresets,
} from "@vibe-tavern/prompt-pipeline";
import type { RegexMacroSource } from "@vibe-tavern/prompt-pipeline";
import type { RegexTextHook } from "../chat/live-chat-orchestrator.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

/** Regex metacharacters — everything that changes meaning inside a pattern. */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape a literal string so it matches verbatim inside a regex pattern.
 * Shared helper (lore-activation-engine has the same idiom inline —
 * consolidate there when that file is next touched).
 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(REGEX_METACHARS, "\\$&");
}

/**
 * Live wiring for the orchestrator's regex seam (REGEX_EXTENSION_PLAN, RX-8).
 *
 * Resolves the chat's active regex presets from the store on every hook fire
 * and runs them through the pure engine. Scope decisions (fixed by the plan):
 *
 * - **Persist-mode only.** Only presets whose apply-target is `persist`
 *   (`markdownOnly`+`promptOnly` both false — see `regexApplyTargetOf`) run at
 *   this seam. Display-only / prompt-only / display+prompt presets are NO-OPS
 *   at generation time: their seams are Wave 3 (client-side render transform
 *   and the assembled-prompt layer transform), where the ORIGINAL must stay
 *   stored while a derived view/prompt is transformed.
 * - **Depth 0 at both hooks.** The message being sent (USER_INPUT) and the
 *   reply being appended (AI_OUTPUT) are each the chat's last message at
 *   transform time, which is ST's depth-0 convention.
 * - **No variant-race by construction.** Persist mode mutates the stored
 *   variant automatically by transforming BEFORE the insert (the RX-5 seam
 *   placement): the variant is created already-transformed, so there is no
 *   post-append rewrite. The `expectedVariantId` guard in
 *   `MessageStore.editMessage` exists for post-hoc rewrites (e.g. a future
 *   run-on-edit flow) — a changed variant can never be overwritten here
 *   because no rewrite happens at all.
 * - **Never throw.** A broken hook must not kill the send path: any failure
 *   (missing chat, store error) logs via `logSendDebug` and returns the text
 *   unchanged.
 */
export class RegexHookService {
  constructor(private readonly stores: StoreContainer) {}

  /** Build the orchestrator's `regexHooks` dependency pair. */
  createHooks(): { onUserInput: RegexTextHook; onAiOutput: RegexTextHook } {
    return {
      onUserInput: (text, ctx) => this.transform(REGEX_PLACEMENT.UserInput, ctx, text),
      onAiOutput: (text, ctx) => this.transform(REGEX_PLACEMENT.AiOutput, ctx, text),
    };
  }

  /** Shared hook body: resolve → filter (placement + depth 0 + persist) → apply. */
  private async transform(
    placement: typeof REGEX_PLACEMENT.UserInput | typeof REGEX_PLACEMENT.AiOutput,
    ctx: { chatId: string; hook: "USER_INPUT" | "AI_OUTPUT" },
    text: string,
  ): Promise<string> {
    if (!text) return text;
    try {
      const chat = await this.stores.chats.getById(ctx.chatId);
      if (!chat) return text;

      const active = await this.stores.regex.resolveActiveRegexPresets({
        characterId: chat.characterId,
        presetId: chat.promptPresetId ?? null,
      });
      const applicable = filterRegexPresets(active, { placement, depth: 0 }).filter(
        (preset) => regexApplyTargetOf(preset) === "persist",
      );
      if (applicable.length === 0) return text;

      return applyRegexLayer(text, applicable, await this.buildMacroSource(chat));
    } catch (err) {
      // A regex hook failure must never break the send path — degrade to the
      // original text (the preset is a text transform, not a safety gate).
      logSendDebug("live.regex.hook-error", {
        chatId: ctx.chatId,
        hook: ctx.hook,
        message: err instanceof Error ? err.message : String(err),
      });
      return text;
    }
  }

  /**
   * Build the engine's injected macro source from the chat's character/persona.
   *
   * `resolveEscaped` substitutes macros with their values regex-ESCAPED so a
   * value like "A(B)" matches literally inside a find pattern. Escaping is
   * applied per-VALUE (the context the engine reads from), not to the resolved
   * pattern — escaping the whole pattern would neutralize its own regex
   * syntax. Each hook fire builds a fresh `MacroEngine` instance so local
   * variable state ({{setvar}} et al.) never leaks across turns.
   */
  private async buildMacroSource(chat: { characterId: string; personaId: string | null }): Promise<RegexMacroSource> {
    const [character, persona] = await Promise.all([
      this.stores.characters.getById(chat.characterId),
      chat.personaId !== null ? this.stores.personas.getById(chat.personaId) : null,
    ]);

    const characterInput = character
      ? {
          name: character.name,
          description: character.description,
          personality: character.personalitySummary,
          scenario: character.defaultScenario,
        }
      : undefined;
    const personaInput = persona
      ? {
          name: persona.name,
          description: persona.description,
          pronouns: persona.pronouns,
          pronounForms: persona.pronounForms,
        }
      : undefined;

    const engine = createFullMacroEngine();
    const resolveContext = buildPromptVariableContext({ character: characterInput, persona: personaInput });
    const escapedContext = buildPromptVariableContext({
      character: characterInput
        ? {
            name: escapeRegexLiteral(characterInput.name),
            description: escapeRegexLiteral(characterInput.description),
            personality: characterInput.personality !== null ? escapeRegexLiteral(characterInput.personality) : null,
            scenario: characterInput.scenario !== null ? escapeRegexLiteral(characterInput.scenario) : null,
          }
        : undefined,
      persona: personaInput
        ? {
            name: escapeRegexLiteral(personaInput.name),
            description: escapeRegexLiteral(personaInput.description),
            pronouns: personaInput.pronouns !== null ? escapeRegexLiteral(personaInput.pronouns) : null,
            // Structured declensions (case forms), not free text — passed through.
            pronounForms: personaInput.pronounForms,
          }
        : undefined,
    });

    return {
      resolve: (text) => engine.resolve(text, resolveContext),
      resolveEscaped: (text) => engine.resolve(text, escapedContext),
    };
  }
}
