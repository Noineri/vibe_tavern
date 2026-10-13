/**
 * The `experience` agent kind — the delegation shell (AGENT_SHELL_PLAN, Wave 1
 * / AS-2a). Self-registers at module init by DELEGATING to the existing
 * experience-copilot module: every species-level fact comes from
 * EXPERIENCE_COPILOT_MODULE / the wire contract; zero new logic lives here.
 * AS-2b/2c will grow this shell with the kind-specific FUNCTIONS (buffers,
 * tool builders, prompt rendering) while the descriptor in agent-kind.ts
 * stays experience-agnostic.
 *
 * Loaded for its side effect — server-runtime.ts imports this beside the
 * other copilot imports so the kind is registered at startup.
 */

import { COPILOT_TOOL_KEYS, copilotToolSetSchema } from "@vibe-tavern/api-contracts";
import { EXPERIENCE_COPILOT_MODULE } from "../../interactive/copilot/experience-copilot-module.js";
import type { AgentKind } from "../agent-kind.js";
import { registerAgentKind } from "../agent-kind-registry.js";

// Project the module's tool set through the wire-contract tool keys (the same
// projection resolveBuiltinCopilotProfile uses) so the contract stays the
// single source of truth for toggleable-tool names: the defaultToolSet carries
// exactly the contract's keys that the module enables.
const defaultToolSet: Record<string, boolean> = {};
for (const key of COPILOT_TOOL_KEYS) {
  if (EXPERIENCE_COPILOT_MODULE.toolSet[key] === true) defaultToolSet[key] = true;
}

registerAgentKind({
  id: "experience",
  servesScriptKinds: ["interactive"],
  basePromptServiceKey: "copilot_base",
  skillRootId: "experience",
  toolSetSchema: copilotToolSetSchema,
  defaultToolSet,
});
