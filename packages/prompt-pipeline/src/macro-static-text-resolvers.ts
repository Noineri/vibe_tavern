import type { MacroCategory, MacroResolver } from "./macro-registry.js";

type StaticTextMacroCategories = Pick<typeof MacroCategory, "Character" | "Identity" | "Time" | "Utility">;

function formatUtcOffsetTime(now: Date, offset: string | undefined, fallback: string): string {
  if (!offset) return fallback;
  const match = /^UTC([+-]\d{1,2})$/.exec(offset);
  if (!match) return fallback;
  const hours = Number(match[1]);
  if (hours < -23 || hours > 23) return fallback;
  const shifted = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return `${shifted.getUTCHours().toString().padStart(2, "0")}:${shifted.getUTCMinutes().toString().padStart(2, "0")}`;
}

function formatDateTime(now: Date, format: string): string {
  const values: Record<string, string> = {
    YYYY: String(now.getFullYear()),
    MM: String(now.getMonth() + 1).padStart(2, "0"),
    DD: String(now.getDate()).padStart(2, "0"),
    HH: String(now.getHours()).padStart(2, "0"),
    mm: String(now.getMinutes()).padStart(2, "0"),
    ss: String(now.getSeconds()).padStart(2, "0"),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => values[token]);
}

function humanizeDuration(milliseconds: number, withSuffix: boolean): string {
  const absolute = Math.abs(milliseconds);
  const units: Array<[number, string]> = [
    [365 * 24 * 60 * 60 * 1000, "year"],
    [30 * 24 * 60 * 60 * 1000, "month"],
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
    [1000, "second"],
  ];
  const [unitMilliseconds, unit] = units.find(([size]) => absolute >= size) ?? [1000, "second"];
  const count = Math.max(1, Math.round(absolute / unitMilliseconds));
  const value = `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (!withSuffix) return value;
  return milliseconds >= 0 ? `in ${value}` : `${value} ago`;
}

function resolveTimeDifference(args: string[]): string {
  const left = new Date(args[0] ?? "");
  const right = new Date(args[1] ?? "");
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return "";
  return humanizeDuration(left.getTime() - right.getTime(), true);
}

/** Registers macros that resolve directly from static prompt context or their arguments. */
export function registerStaticTextMacroResolvers(
  register: (resolver: MacroResolver) => void,
  categories: StaticTextMacroCategories,
): void {
  register({
    name: "charPrompt",
    description: "The character's main prompt override.",
    category: categories.Character,
    resolve: (_args, context) => context.character.systemPrompt ?? "",
  });
  register({
    name: "charInstruction",
    description: "The character's post-history instruction override.",
    category: categories.Character,
    resolve: (_args, context) => context.character.postHistoryInstructions ?? "",
  });
  register({
    name: "systemPrompt",
    description: "The active system prompt, using the character override when present.",
    category: categories.Character,
    // Keep the simple-mode precedence exposed by assemble.ts: a non-empty character
    // override wins; otherwise use the active preset's main prompt.
    resolve: (_args, context) => context.character.systemPrompt?.trim() || context.prompt.system,
  });
  register({
    name: "defaultSystemPrompt",
    description: "The main prompt from the default preset.",
    category: categories.Character,
    resolve: (_args, context) => context.prompt.defaultSystemPrompt ?? "",
  });
  register({
    name: "authorsNote",
    description: "The active preset's author's note.",
    category: categories.Character,
    resolve: (_args, context) => context.prompt.authorsNote ?? "",
  });
  register({
    name: "defaultAuthorsNote",
    description: "The author's note from the default preset.",
    category: categories.Character,
    resolve: (_args, context) => context.prompt.defaultAuthorsNote ?? "",
  });
  register({
    name: "notChar",
    description: "Participants other than the current character.",
    category: categories.Identity,
    resolve: (_args, context) => context.names.notChar || context.names.userName,
  });
  register({
    name: "reverse",
    description: "Reverse the characters in an argument.",
    category: categories.Utility,
    resolve: (args) => Array.from(args[0] ?? "").reverse().join(""),
  });
  register({
    name: "datetimeformat",
    description: "Format the current date and time with YYYY, MM, DD, HH, mm, and ss tokens.",
    category: categories.Time,
    resolve: (args, context) => formatDateTime(context.time.now, args[0] ?? ""),
  });
  register({
    name: "idleDuration",
    aliases: ["idle_duration"],
    description: "Time since the prior user message.",
    category: categories.Time,
    resolve: (_args, context) => context.chat.idleDuration ?? "",
  });
  register({
    name: "timeDiff",
    description: "Human-readable difference between two times.",
    category: categories.Time,
    resolve: (args) => resolveTimeDifference(args),
  });
  register({
    name: "time",
    description: "Current local time, or time at a UTC offset such as UTC+2.",
    category: categories.Time,
    resolve: (args, context) => formatUtcOffsetTime(context.time.now, args[0], context.time.time),
  });
}

export function formatIdleDuration(now: Date, priorUserMessageAt: string | null): string {
  if (!priorUserMessageAt) return "just now";
  const prior = new Date(priorUserMessageAt);
  if (Number.isNaN(prior.getTime())) return "just now";
  return humanizeDuration(now.getTime() - prior.getTime(), false);
}
