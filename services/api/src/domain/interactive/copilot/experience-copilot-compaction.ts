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
 *   - the summarizer system-prompt RESOLVER (SC-8a: the `copilot_compaction`
 *     service prompt — the active service-prompt profile's override, else the
 *     `experience-copilot/compaction.md` asset, whose text is the former
 *     `COMPACTION_SYSTEM_PROMPT` constant byte-identical, so nothing changes
 *     for a user who never edits it),
 *   - the digest sampler constants (copilot-limits.ts, owner-fixed numbers),
 *   - the thread error label + debug-log channel names.
 *
 * It stays (AS-10b, 2026-10-18): matching the script kind's per-kind module was the plan's rule — no longer a shim to remove.
 */

import type { AppDb, ExperienceCopilotStore, ExperienceCopilotMessage } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { AttachmentAssetLoader } from "../../../infrastructure/ai/vision-gate.js";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import { AgentCompactionService } from "../../agent/agent-compaction.js";
import { storeMessagesToHistory } from "../../agent/agent-stream.js";
import { resolveServicePromptText } from "../../service-prompts/service-prompt-resolver.js";
import { getServicePromptAssetFile } from "../../service-prompts/service-prompt-registry.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "./copilot-limits.js";

export type {
  CompactCopilotInput,
  CompactCopilotResult,
} from "../../agent/agent-compaction.js";

/** The experience wiring of the generic {@link AgentCompactionService} — same
 *  constructor surface (store / provider profiles / injectable executor) as
 *  pre-AS-2b, so the adapter and tests construct it untouched; SC-8a adds the
 *  optional `db` handle that unlocks the service-prompt override tier
 *  (absent → the bundled asset only, the pre-SC-8a behavior). */
export class ExperienceCopilotCompactionService extends AgentCompactionService<ExperienceCopilotMessage> {
  constructor(
    store: ExperienceCopilotStore,
    providerProfiles: ProviderProfileService,
    execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
    db?: AppDb,
    attachmentAssetLoader?: AttachmentAssetLoader,
  ) {
    super(store, providerProfiles, execute, {
      attachmentAssetLoader,
      storeMessagesToFlow: storeMessagesToHistory,
      // SC-8a: the summarizer prompt is the `copilot_compaction` service
      // prompt — profile override first, else the asset (the former constant,
      // byte-identical). The optional-db ternary is the same wiring every
      // service-prompt consumer uses (e.g. `resolveBuiltinSidechatOocProfile`).
      resolveSystemPrompt: () =>
        db
          ? resolveServicePromptText(db, "copilot_compaction")
          : loadPromptAsset(getServicePromptAssetFile("copilot_compaction")),
      overrideTemperature: COPILOT_COMPACT_TEMPERATURE,
      overrideMaxTokens: COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
      threadLabel: "ExperienceCopilotThread",
      logChannelPrefix: "api.experience-copilot",
    });
  }
}
