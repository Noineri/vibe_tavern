import type { MacroResolver } from "./macro-registry.js";
import { rollDice } from "./dice.js";

/** Deterministic 32-bit hash for chat-stable macro choices. */
function hashMacroSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function resolveOptions(args: string[]): string[] {
  if (args.length === 1 && args[0].includes(",")) {
    return args[0].split(",").map((item) => item.trim());
  }
  return args;
}

/** Randomization macro registrations kept separate from the core parser. */
export function createRandomMacroResolvers(): MacroResolver[] {
  return [
    {
      name: "random",
      description: "Pick one option at random: {{random::a::b::c}} or {{random:a,b,c}}.",
      category: "random",
      resolve: (args) => {
        const items = resolveOptions(args);
        if (items.length === 0) return "";
        return items[Math.floor(Math.random() * items.length)];
      },
    },
    {
      name: "pick",
      description: "Pick one stable option per chat and macro position: {{pick::a::b::c}}.",
      category: "random",
      resolve: (args, context, _state, _variables, _resolveNested, sourceOffset) => {
        const items = resolveOptions(args);
        if (items.length === 0) return "";
        const index = hashMacroSeed(`${context.chat.id}:${sourceOffset}`) % items.length;
        return items[index];
      },
    },
    {
      name: "roll",
      description: "Roll dice and emit the total: {{roll::1d20}}, {{roll::3d6+2}}.",
      category: "random",
      resolve: (args) => {
        const formula = args[0]?.trim() ?? "";
        if (!formula) return "";
        // "d20" and ST's bare-number form "20" both mean one die.
        const normalized = /^d\d+/i.test(formula)
          ? "1" + formula
          : /^\d+$/.test(formula) ? `1d${formula}` : formula;
        const result = rollDice(normalized);
        return result ? String(result.total) : "";
      },
    },
  ];
}
