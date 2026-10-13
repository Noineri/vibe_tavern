/**
 * SHIM (AGENT_SHELL_PLAN, Wave 2 / AS-2b) — the generic compaction MECHANISM
 * moved to `domain/agent/agent-compaction.ts` (`AgentCompactionService`: budget
 * trim, digest boundary, echo stubs, token estimate). What could NOT move —
 * the EXPERIENCE seams the mechanism injects — stays here and is wired by a
 * thin subclass under the old export name, so every importer (adapter, tests)
 * compiles and behaves EXACTLY as before:
 *
 *   - `storeMessagesToHistory` (the stored-message → flow conversion lives in
 *     the stream module; AS-2c carves the stream and can absorb the seam),
 *   - the summarizer system prompt (describes interactive-experience
 *     authoring — kind-owned prose),
 *   - the digest sampler constants (copilot-limits.ts, owner-fixed numbers),
 *   - the thread error label + debug-log channel names.
 *
 * This file is NOT a pure re-export because the seams need wiring; AS-10
 * removes it (the seams move into the kind's descriptor when it grows them).
 */

import type { ExperienceCopilotStore, ExperienceCopilotMessage } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import { AgentCompactionService } from "../../agent/agent-compaction.js";
import { storeMessagesToHistory } from "./experience-copilot-stream.js";
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
