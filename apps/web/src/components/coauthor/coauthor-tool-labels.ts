import { COAUTHOR_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import type { TFunc } from "../../i18n/context.js";
import type Resources from "../../i18n/resources.js";

/**
 * Human-readable labels for the co-author module editor's tool toggles
 * (HOTFIX-UI, owner instruction 2026-10-10). Single consumer:
 * `CoauthorModuleModal.tsx` (editor pills + read-only view chips) — the
 * review card and activity slot keep their own existing label keys.
 */
export type CoauthorToolKey = (typeof COAUTHOR_TOOL_KEYS)[number];

/**
 * Human-readable label for every toggleable co-author tool, as i18n key names.
 * Exhaustive over `COAUTHOR_TOOL_KEYS` (the wire contract stays the single
 * source of truth): adding a tool to `coauthorToolSetSchema` fails typecheck
 * here until a label is added. The `keyof Resources["en"]` value type proves
 * at compile time that every label key exists. Two entries reuse existing
 * activity labels (`coauthor_tool_search_label`,
 * `coauthor_tool_tracker_template`) instead of duplicating copy for the same
 * tool.
 */
export const COAUTHOR_TOOL_LABEL_KEYS: Record<CoauthorToolKey, keyof Resources["en"]> = {
	write_profile: "coauthor.module.tool.write_profile",
	edit_personality: "coauthor.module.tool.edit_personality",
	edit_scenario: "coauthor.module.tool.edit_scenario",
	edit_examples: "coauthor.module.tool.edit_examples",
	write_personality: "coauthor.module.tool.write_personality",
	write_scenario: "coauthor.module.tool.write_scenario",
	write_examples: "coauthor.module.tool.write_examples",
	edit_greeting: "coauthor.module.tool.edit_greeting",
	add_alt_greeting: "coauthor.module.tool.add_alt_greeting",
	edit_alt_greeting: "coauthor.module.tool.edit_alt_greeting",
	create_lorebook: "coauthor.module.tool.create_lorebook",
	create_lore_entry: "coauthor.module.tool.create_lore_entry",
	set_lore_activation: "coauthor.module.tool.set_lore_activation",
	edit_lorebook: "coauthor.module.tool.edit_lorebook",
	edit_lore_entry: "coauthor.module.tool.edit_lore_entry",
	add_lore_entry: "coauthor.module.tool.add_lore_entry",
	ai_write_lore_entry: "coauthor.module.tool.ai_write_lore_entry",
	ai_generate_lore_keys: "coauthor.module.tool.ai_generate_lore_keys",
	search_context: "coauthor_tool_search_label",
	read_context_item: "coauthor.module.tool.read_context_item",
	set_tracker_template: "coauthor_tool_tracker_template",
};

/**
 * Resolve a tool key to its rendered label. Unknown (future) keys fall back
 * to the raw key — never blank, never a crash.
 */
export function resolveCoauthorToolLabel(t: TFunc, key: string): string {
	const labelKey = (COAUTHOR_TOOL_LABEL_KEYS as Record<string, keyof Resources["en"]>)[key];
	return labelKey ? t(labelKey) : key;
}
