/**
 * SHIM (AGENT_SHELL_PLAN, Wave 2 / AS-2b) — the pinned-context loader moved
 * VERBATIM to `domain/agent/agent-context.ts` (it was already kind-agnostic:
 * character/persona/lorebook/script/skill). This re-export shell keeps every
 * importer (stream, adapter, tests) compiling untouched; AS-10 removes it.
 */

export {
  getCopilotContextItems,
  renderAttachedContext,
  type AgentContextLink,
  type CopilotContextItemType,
  type CopilotContextItem,
  type CopilotSkillSource,
  type CopilotContextDeps,
} from "../../agent/agent-context.js";
