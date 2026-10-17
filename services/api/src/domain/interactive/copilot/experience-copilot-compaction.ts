/**
 * Experience-kind compaction module (AGENT_SHELL_PLAN, AS-10b) — the
 * EXPERIENCE wiring of the generic `domain/agent/agent-compaction.ts`
 * `AgentCompactionService` (budget trim, digest boundary, echo stubs, token
 * estimate) — the same pattern as the script kind's per-kind module
 * (`script-agent-compaction.ts`): a per-kind subclass under the kind-owned
 * export name, so every importer (adapter, tests) compiles and behaves
 * EXACTLY as before. What this module injects is the kind-owned seam set:
 *
 *   - `storeMessagesToHistory` (stored-message → flow conversion, now from
 *     `domain/agent/agent-stream.ts` since AS-10a — the settled generic),
 *   - the summarizer system prompt (describes interactive-experience
 *     authoring — kind-owned prose),
 *   - the digest sampler constants (copilot-limits.ts, owner-fixed numbers),
 *   - the thread error label + debug-log channel names.
 *
 * It stays (AS-10b, 2026-10-18): matching the script kind's per-kind module was the plan's rule — no longer a shim to remove.
 */

import type { ExperienceCopilotStore, ExperienceCopilotMessage } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import { AgentCompactionService } from "../../agent/agent-compaction.js";
import { storeMessagesToHistory } from "../../agent/agent-stream.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "./copilot-limits.js";

export type {
  CompactCopilotInput,
  CompactCopilotResult,
} from "../../agent/agent-compaction.js";

/** The summarization system prompt: dense, self-contained, and lossless with
 *  respect to decisions / current state / TODOs / tool findings. Stays with the
 *  experience kind — it describes the domain being summarized. */
const COMPACTION_SYSTEM_PROMPT = [
  "You are compacting the history of an AI pair-programming session that authors Vibe Tavern interactive experiences (a `rules` JavaScript package registered via `context.experience.register`, and an optional `visual` package).",
  "Produce a DENSE, self-contained summary of the conversation below that a future turn can use INSTEAD of the original messages.",
  "Preserve, with concrete detail:",
  "- Decisions made and their rationale.",
  "- The CURRENT state of the rules package and visual package: the latest accepted edits (write_buffer / edit_buffer proposals) and the user's feedback on them.",
  "- Open TODOs, unresolved questions, and explicit next steps.",
  "- Tool findings (run_test / run_simulate results, skill-file findings) that changed the plan.",
  "Do NOT invent anything not present in the transcript. Output ONLY the summary text — no preamble, no markdown fences.",
].join("\n");

/** The experience wiring of the generic {@link AgentCompactionService} — same
 *  constructor surface (store / provider profiles / injectable executor) as
 *  pre-AS-2b, so the adapter and tests construct it untouched. */
export class ExperienceCopilotCompactionService extends AgentCompactionService<ExperienceCopilotMessage> {
  constructor(
    store: ExperienceCopilotStore,
    providerProfiles: ProviderProfileService,
    execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
  ) {
    super(store, providerProfiles, execute, {
      storeMessagesToFlow: storeMessagesToHistory,
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      overrideTemperature: COPILOT_COMPACT_TEMPERATURE,
      overrideMaxTokens: COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
      threadLabel: "ExperienceCopilotThread",
      logChannelPrefix: "api.experience-copilot",
    });
  }
}
