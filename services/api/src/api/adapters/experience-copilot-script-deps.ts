/**
 * The `script` kind's stream-deps builder for the ExperienceCopilotAdapter
 * (AS-8b) — extracted verbatim from experience-copilot-adapter.ts at the
 * arch-gate size cap (DMT-24's delegate wiring left the file no headroom).
 * The seams object is the adapter's own construction state; the built deps
 * are byte-identical to the pre-extraction method's return. The pinned-context
 * resolver stays the ADAPTER's one private derivation
 * (`buildContextItemsResolver`) and rides in as a seam — no second copy.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type { CopilotContextItem } from "../../domain/agent/agent-context.js";
import type { ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import type {
	ScriptAgentStreamDeps,
} from "../../domain/agent/script-agent/script-agent-stream.js";
import type { AgentTurnDeleteTurn } from "../../domain/agent/agent-regenerate.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";
import { AgentReviewService } from "../../domain/agent/agent-review-service.js";
import type { CopilotProfileResolver } from "../../domain/interactive/copilot/copilot-profile-resolver.js";
import type { ScriptAgentCompactionService } from "../../domain/agent/script-agent/script-agent-compaction.js";
import { resolveScriptAgentContextCards } from "./experience-copilot-script-cards.js";
import type { buildAgentProviderDeps } from "./experience-copilot-provider-deps.js";

/** The adapter construction state the script deps read. */
export interface ScriptStreamDepsSeams {
	readonly stores: StoreContainer;
	readonly providerDeps: ReturnType<typeof buildAgentProviderDeps>;
	readonly profileResolver: CopilotProfileResolver;
	/** The SCRIPT kind's own skill library (AS-8d1) — its user root seeds the
	 *  two-root catalog; absent → built-in root only (lifecycle-only
	 *  harnesses). */
	readonly scriptSkillService?: SkillLibraryService;
	/** The shared kind-agnostic pinned-context loader over the SCRIPT skill
	 *  library (the adapter's `buildContextItemsResolver` — the ONE
	 *  derivation); undefined when the script skill library is absent. */
	readonly contextItemsResolver?: ((links: readonly ExperienceCopilotContextLink[]) => Promise<CopilotContextItem[]>) | undefined;
	/** CM-6: absent (no provider profile service) → no auto-compaction hook. */
	readonly scriptCompaction?: ScriptAgentCompactionService | null;
	/** AP-9: the shared regenerate row-deletion seam. */
	readonly deleteTurn: AgentTurnDeleteTurn;
}

/** AS-8b: the `script` kind's stream deps — the same store/provider seams the
 *  experience wiring uses, with the script-owned context (owner names + full
 *  cards, trust), the shared kind-agnostic pinned-context loader over the
 *  SCRIPT skill library (AS-8e1), and the script kind's own auto-compaction
 *  (script-authoring summarizer). */
export function buildScriptAgentStreamDeps(seams: ScriptStreamDepsSeams): ScriptAgentStreamDeps {
	return {
		store: seams.stores.experienceCopilot,
		reviews: new AgentReviewService(seams.stores),
		agentPlans: seams.stores.agentPlans,
		getScript: (scriptId: string) => seams.stores.scripts.getById(scriptId),
		getContextCards: (input: {
			scriptId: string | null;
			contextCharacterId?: string;
			contextPersonaId?: string;
		}) => resolveScriptAgentContextCards(seams.stores, input),
		...seams.providerDeps,
		// Kind-aware fallback (AS-8b): prompt/dice scripts seed the `script`
		// kind's builtin, interactive scripts the experience one.
		resolveProfile: (scriptId) => seams.profileResolver.resolveForScript(scriptId),
		// SC-0f: a chat-owned thread's profile chain (the chat's own choice →
		// the kind default → the kind's built-in) — the stream consults it only
		// when the thread's owner columns say chat-owned.
		resolveProfileForChat: (thread) =>
			seams.profileResolver.resolveForChat(thread.chatId, thread.agentKind),
		// Two-root catalog user root for the SCRIPT kind (AS-8d1 — the script
		// service's own root, never the experience copilot one): absent →
		// built-in root only.
		...(seams.scriptSkillService !== undefined
			? { skillUserRoot: seams.scriptSkillService.roots().userRoot }
			: {}),
		db: seams.stores.db,
		// Same kind-agnostic pinned-context loader as the experience wiring —
		// only wired when the skill library is present.
		...(seams.contextItemsResolver !== undefined ? { resolveContextItems: seams.contextItemsResolver } : {}),
		// CM-6: fire-and-forget auto-compaction through the SCRIPT service
		// (absent when the adapter has no provider profile service).
		...(seams.scriptCompaction != null
			? { autoCompact: (threadId: string) => seams.scriptCompaction!.autoCompactAfterTurn(threadId) }
			: {}),
		// AP-9 regenerate row-deletion seam (the shared AP-8 store sibling).
		deleteTurn: seams.deleteTurn,
		stores: seams.stores,
	};
}
