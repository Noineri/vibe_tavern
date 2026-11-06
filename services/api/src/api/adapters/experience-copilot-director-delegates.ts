/**
 * The Director message-tool delegate slot of the ExperienceCopilotAdapter
 * (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-24) — extracted into this sibling at the
 * arch-gate size cap (experience-copilot-adapter.ts has no size headroom).
 *
 * The composition root (runtime-api-adapter's `wireDirectorMessageDelegates`)
 * injects the REAL chat-runtime delegates AFTER both adapters are constructed
 * (the chat adapter needs the copilot's shared run registry, so it cannot be
 * a constructor dependency); the sidechat stream deps
 * (`buildSidechatStreamDeps`) spread the slot's entries at stream time, so a
 * turn picks up whatever the composition wired — and lifecycle-only harnesses
 * that never configure the slot keep the pre-DMT-24 contract (the granted
 * swipe executor and the edit tool refuse loudly at call time — the DMT-14
 * delegate-seam pattern). No upward import: the factories close over the
 * adapters at the composition root; this module only carries their types.
 */

import type { DirectorMessageEditorDelegateFn } from "../../domain/agent/kinds/sidechat/sidechat-message-tools.js";
import type { SidechatStreamDeps } from "../../domain/sidechat/sidechat-stream.js";
import type { DirectorSwipeGenerationDelegate } from "../../domain/sidechat/sidechat-swipe-executor.js";

/** The two delegate factories the runtime composition injects (both lazy —
 *  the tracker delegate's seam shape: a turn that never invokes the tool pays
 *  nothing). */
export interface DirectorMessageDelegateFactories {
	/** The DMT-14 message-editor delegate an invoked `propose_message_edit`
	 *  generates through (the ordinary `message_edit` task, the Director as
	 *  the instruction author). */
	readonly buildMessageEditorDelegate?: () => Promise<DirectorMessageEditorDelegateFn | undefined>;
	/** The DMT-24 swipe GENERATION delegate an allowed `request_message_swipe`
	 *  resumes through (the branch-pinned RP regeneration over the normal
	 *  lifecycle). */
	readonly buildSwipeGenerationDelegate?: () => Promise<DirectorSwipeGenerationDelegate | undefined>;
}

export interface DirectorDelegateSlot {
	configure(delegates: DirectorMessageDelegateFactories): void;
	/** The `SidechatStreamDeps` spread entries for the two seams — an empty
	 *  object until configured (the absent-seam refusals stay armed). */
	sidechatStreamEntries(): Pick<SidechatStreamDeps, "buildMessageEditorDelegate" | "buildSwipeGenerationDelegate">;
}

export function createDirectorDelegateSlot(): DirectorDelegateSlot {
	let current: DirectorMessageDelegateFactories = {};
	return {
		configure: (delegates) => {
			current = delegates;
		},
		sidechatStreamEntries: () => ({
			...(current.buildMessageEditorDelegate !== undefined
				? { buildMessageEditorDelegate: current.buildMessageEditorDelegate }
				: {}),
			...(current.buildSwipeGenerationDelegate !== undefined
				? { buildSwipeGenerationDelegate: current.buildSwipeGenerationDelegate }
				: {}),
		}),
	};
}
