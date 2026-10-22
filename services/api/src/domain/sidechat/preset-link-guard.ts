/**
 * The preset-pin ownership guard (SIDECHAT_PLAN Wave 5b / SC-23c) — extracted
 * under the file-size ratchet when the adapter's set-links method crossed the
 * cap (the extraction IS the gate's prescribed remedy, not a behavior change).
 *
 * A `prompt_preset` context link is the sidechat's RP-prompt discussion arm:
 * the sidechat context loader assembles it against the THREAD's chat + branch,
 * so the link exists only on chat-owned threads. The wire set-links path
 * (ExperienceCopilotAdapter.experienceCopilotSetContextLinks) refuses a
 * replace whose array carries one on a script-owned or draft thread with the
 * typed 400 below — the same lowercase DomainError `Validation` family as
 * `attached_variant_not_in_branch` (rp-branch-view.ts). The whole replace is
 * refused: nothing is written, valid links included.
 *
 * Pure: an ownership test plus the typed throw — no store reads (the caller
 * hands in the thread row it already loaded for its not-found check).
 */

import type { CopilotContextLink, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadId } from "@vibe-tavern/domain";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { validation } from "../../shared/errors.js";

/** Typed-validation code (SC-23c): a `prompt_preset` context link was pinned
 *  on a thread that is not chat-owned (script-owned or draft). DomainError
 *  `Validation` (the 400 family) carries this code in `details`. */
export const PRESET_LINK_NOT_CHAT_OWNED_CODE = "preset_link_not_chat_owned";

/** Refuse a link set that pins a prompt preset on a non-chat-owned thread
 *  (SC-23c). No-op otherwise — every other target type stays kind-agnostic
 *  (the picker offers them to every kind). Throws before any store write. */
export function assertPresetLinksChatOwned(input: {
	threadId: ExperienceCopilotThreadId | string;
	thread: Pick<ExperienceCopilotThread, "chatId" | "agentKind">;
	links: readonly Pick<CopilotContextLink, "targetType">[];
}): void {
	if (!input.links.some((link) => link.targetType === "prompt_preset")) return;
	if (isChatOwnedAgentThread(input.thread)) return;
	throw validation(
		"A prompt preset can be pinned only on a chat-owned thread (a sidechat); " +
			`thread '${input.threadId}' is script-owned or a draft.`,
		{
			code: PRESET_LINK_NOT_CHAT_OWNED_CODE,
			targetType: "prompt_preset",
			threadId: input.threadId,
		},
	);
}
