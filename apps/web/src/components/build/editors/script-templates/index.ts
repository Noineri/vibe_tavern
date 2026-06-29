/**
 * Built-in script templates registry.
 *
 * Each template's body lives in its own `.js` file (editor support: syntax
 * highlighting, linting, formatting — none of which exist for code embedded in
 * TS template strings). Vite's `?raw` suffix imports the file content as a
 * plain string at build time; `vite/client` (in tsconfig types) declares the
 * module shape so the import typechecks. Precedent: `ThemeTuner.tsx` imports
 * theme CSS the same way.
 *
 * Keys mirror the i18n keys (`script_template_<key>` in
 * `apps/web/src/i18n/locales/*.json`); the UI renders the localized name and
 * falls back to `name` here when a locale is missing the key.
 */
import relationshipCode from "./relationship.js?raw";
import eventsCode from "./events.js?raw";
import memoryCode from "./memory.js?raw";
import lorebookCode from "./lorebook.js?raw";
import advancedLoreCode from "./advanced-lore.js?raw";
import hpCode from "./hp.js?raw";
import diceCode from "./dice.js?raw";
import randomCode from "./random.js?raw";

export interface ScriptTemplate {
  /** Fallback label (used when the i18n key `script_template_<key>` is absent). */
  name: string;
  /** Raw JavaScript source — executed as-is in the script sandbox. */
  code: string;
}

export const SCRIPT_TEMPLATES: Record<string, ScriptTemplate> = {
  relationship: { name: "Relationship Progression", code: relationshipCode },
  events: { name: "Scenario Events", code: eventsCode },
  memory: { name: "Conversation Memory", code: memoryCode },
  lorebook: { name: "Dynamic Lorebook", code: lorebookCode },
  advanced_lore: { name: "Advanced Lorebook", code: advancedLoreCode },
  hp: { name: "HP Tracker", code: hpCode },
  dice: { name: "Dice Roller", code: diceCode },
  random: { name: "Random Event", code: randomCode },
};
