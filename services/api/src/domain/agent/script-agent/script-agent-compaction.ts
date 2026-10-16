/**
 * Script-agent compaction service (AGENT_SHELL_PLAN, AS-8b-fix-A) — the
 * `script` kind's wiring of the generic {@link AgentCompactionService}.
 * Mirrors the experience subclass (`experience-copilot-compaction.ts`): the
 * generic mechanism (budget trim, digest boundary, echo stubs, token
 * estimate) is shared; what is injected here is the SCRIPT-AUTHORING
 * summarizer prompt, so a script thread's digest never carries
 * experience-flavored prose.
 *
 * The stored-message → flow conversion (`storeMessagesToHistory`) is generic
 * and lives in `agent-stream.ts`; the digest sampler constants are the same
 * owner-fixed copilot numbers the experience kind uses.
 */

import type { ExperienceCopilotStore, ExperienceCopilotMessage } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import { AgentCompactionService } from "../agent-compaction.js";
import { storeMessagesToHistory } from "../agent-stream.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "../../interactive/copilot/copilot-limits.js";

/** The summarization system prompt for script-authoring sessions: dense,
 *  self-contained, and lossless with respect to decisions / current state /
 *  TODOs / tool findings. Stays with the script kind — it describes the
 *  domain being summarized. */
export const SCRIPT_AGENT_COMPACTION_SYSTEM_PROMPT = [
  "You are compacting the history of an AI pair-programming session that authors Vibe Tavern scripts (a `prompt` script that shapes the prompt, or a `dice` script that drives dice rolls), edited in a single `code` buffer.",
  "Produce a DENSE, self-contained summary of the conversation below that a future turn can use INSTEAD of the original messages.",
  "Preserve, with concrete detail:",
  "- Decisions made and their rationale.",
  "- The CURRENT state of the `code` buffer: the latest accepted edits (write_buffer / edit_buffer proposals) and the user's feedback on them.",
  "- Open TODOs, unresolved questions, and explicit next steps.",
  "- Tool findings (run_script_test results, skill-file findings) that changed the plan.",
  "Do NOT invent anything not present in the transcript. Output ONLY the summary text — no preamble, no markdown fences.",
].join("\n");

/** The script wiring of the generic {@link AgentCompactionService} — same
 *  constructor surface (store / provider profiles / injectable executor) as
 *  the experience subclass. */
export class ScriptAgentCompactionService extends AgentCompactionService<ExperienceCopilotMessage> {
  constructor(
    store: ExperienceCopilotStore,
    providerProfiles: ProviderProfileService,
    execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
  ) {
    super(store, providerProfiles, execute, {
      storeMessagesToFlow: storeMessagesToHistory,
      systemPrompt: SCRIPT_AGENT_COMPACTION_SYSTEM_PROMPT,
      overrideTemperature: COPILOT_COMPACT_TEMPERATURE,
      overrideMaxTokens: COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
      threadLabel: "ScriptAgentThread",
      logChannelPrefix: "api.script-agent",
    });
  }
}
