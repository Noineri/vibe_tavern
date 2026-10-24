import {
	COPILOT_TOOL_KEYS,
	SCRIPT_AGENT_TOOL_KEYS,
	SIDECHAT_OOC_TOOL_KEYS,
} from "@vibe-tavern/api-contracts";
import type { TFunc } from "../../../i18n/context.js";
import type { AgentI18nKey } from "../../../lib/agent-host-registry.js";

/**
 * Human-readable labels for the agent profile modal's tool toggles (AP-24,
 * owner table 2026-10-22). One consumer: `AgentProfileModal.tsx` (editor
 * pills + read-only view chips). The pattern is `coauthor-tool-labels.ts`:
 * every map is EXHAUSTIVE over its kind's wire toggle keys (derived from the
 * `*ToolSetSchema` in `experience-copilot-schema.ts`), so adding a tool to a
 * schema fails typecheck here until a label is added. The value type
 * `AgentI18nKey` (`keyof Resources["en"]`) proves at compile time that every
 * label key exists.
 *
 * Keys shared by several kinds carry the same label key in each map
 * (`plan`, `todo`, `ask_user`); `write_buffer`, `edit_buffer` and
 * `read_plan` DIFFER by kind, so the map is per kind — never one flat
 * key → label table.
 */
export type ExperienceProfileToolKey = (typeof COPILOT_TOOL_KEYS)[number];
export type ScriptProfileToolKey = (typeof SCRIPT_AGENT_TOOL_KEYS)[number];
export type SidechatProfileToolKey = (typeof SIDECHAT_OOC_TOOL_KEYS)[number];

/** Mini-apps (experience) labels — `copilotToolSetSchema` order. */
export const EXPERIENCE_PROFILE_TOOL_LABEL_KEYS: Record<ExperienceProfileToolKey, AgentI18nKey> = {
	write_buffer: "agent_tool_write_file",
	edit_buffer: "agent_tool_edit_file",
	run_test: "agent_tool_run_test",
	run_simulate: "agent_tool_run_simulate",
	suggest_visual_binding: "agent_tool_suggest_visual_binding",
	plan: "agent_tool_plan",
	read_plan: "agent_tool_read_plan_steps",
	todo: "agent_tool_todo",
	ask_user: "agent_tool_ask_user",
};

/** Script labels — `scriptAgentToolSetSchema` order. */
export const SCRIPT_PROFILE_TOOL_LABEL_KEYS: Record<ScriptProfileToolKey, AgentI18nKey> = {
	write_buffer: "agent_tool_write_script",
	edit_buffer: "agent_tool_edit_script",
	run_script_test: "agent_tool_run_script_test",
	plan: "agent_tool_plan",
	read_plan: "agent_tool_read_plan_steps",
	ask_user: "agent_tool_ask_user",
};

/** Sidechat labels — `sidechatOocToolSetSchema` order. */
export const SIDECHAT_PROFILE_TOOL_LABEL_KEYS: Record<SidechatProfileToolKey, AgentI18nKey> = {
	search_context: "agent_tool_search_context",
	read_context_item: "agent_tool_read_context_item",
	propose_objective: "agent_tool_propose_objective",
	todo: "agent_tool_todo",
	read_plan: "agent_tool_read_plan_branch",
	read_message_prompt: "agent_tool_read_message_prompt",
};

/**
 * Resolve a tool key to its rendered label for an agent kind. Unknown
 * (future) keys fall back to the raw key — never blank, never a crash.
 * The kind selects the map (`script` → script, `sidechat-ooc` → sidechat,
 * anything else → experience); shared keys resolve identically everywhere.
 */
export function resolveAgentProfileToolLabel(t: TFunc, agentKind: string, key: string): string {
	const map: Record<string, AgentI18nKey> =
		agentKind === "script"
			? SCRIPT_PROFILE_TOOL_LABEL_KEYS
			: agentKind === "sidechat-ooc"
				? SIDECHAT_PROFILE_TOOL_LABEL_KEYS
				: EXPERIENCE_PROFILE_TOOL_LABEL_KEYS;
	const labelKey = map[key];
	return labelKey ? t(labelKey) : key;
}
