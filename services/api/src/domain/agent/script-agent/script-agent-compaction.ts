/**
 * Script-agent compaction service (AGENT_SHELL_PLAN, AS-8b-fix-A) — the
 * `script` kind's wiring of the generic {@link AgentCompactionService}.
 * Mirrors the experience subclass (`experience-copilot-compaction.ts`): the
 * generic mechanism (budget trim, digest boundary, echo stubs, token
 * estimate) is shared; what is injected here is the SCRIPT-AUTHORING
 * summarizer prompt RESOLVER (SC-8a: the `script_agent_compaction` service
 * prompt — the active service-prompt profile's override, else the
 * `agent-script/compaction.md` asset, whose text is the former
 * `SCRIPT_AGENT_COMPACTION_SYSTEM_PROMPT` constant byte-identical), so a
 * script thread's digest never carries experience-flavored prose.
 *
 * The stored-message → flow conversion (`storeMessagesToHistory`) is generic
 * and lives in `agent-stream.ts`; the digest sampler constants are the same
 * owner-fixed copilot numbers the experience kind uses.
 */

import type { AppDb, ExperienceCopilotStore, ExperienceCopilotMessage } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { AttachmentAssetLoader } from "../../../infrastructure/ai/vision-gate.js";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import { AgentCompactionService } from "../agent-compaction.js";
import { storeMessagesToHistory } from "../agent-stream.js";
import { resolveServicePromptText } from "../../service-prompts/service-prompt-resolver.js";
import { getServicePromptAssetFile } from "../../service-prompts/service-prompt-registry.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "../../interactive/copilot/copilot-limits.js";

/** The script wiring of the generic {@link AgentCompactionService} — same
 *  constructor surface (store / provider profiles / injectable executor) as
 *  the experience subclass; SC-8a adds the optional `db` handle that unlocks
 *  the service-prompt override tier (absent → the bundled asset only, the
 *  pre-SC-8a behavior). */
export class ScriptAgentCompactionService extends AgentCompactionService<ExperienceCopilotMessage> {
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
      // SC-8a: the summarizer prompt is the `script_agent_compaction` service
      // prompt — profile override first, else the asset (the former constant,
      // byte-identical). The optional-db ternary is the same wiring every
      // service-prompt consumer uses (e.g. `resolveBuiltinSidechatOocProfile`).
      resolveSystemPrompt: () =>
        db
          ? resolveServicePromptText(db, "script_agent_compaction")
          : loadPromptAsset(getServicePromptAssetFile("script_agent_compaction")),
      overrideTemperature: COPILOT_COMPACT_TEMPERATURE,
      overrideMaxTokens: COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
      threadLabel: "ScriptAgentThread",
      logChannelPrefix: "api.script-agent",
    });
  }
}
