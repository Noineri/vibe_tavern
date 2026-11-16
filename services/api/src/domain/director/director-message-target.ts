/**
 * Director message-target resolver (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-21).
 *
 * The ONE resolution the Director's three message tools share: a model-named
 * branch `position` (plus optional variant number) → the COMMITTED ASSISTANT
 * reply in the THREAD's branch with its swipe frozen into immutable identity
 * (messageId/variantId) + the review base text. Resolution reads go through
 * NARROW INJECTED STORES (`Pick`s of `MessageStore`, the same seam the
 * prompt-read tool uses) — never through the request, never through the
 * browser's active chat: the caller passes the thread row's own branch (the
 * plan's ownership rule: resolve once against the thread's chat and branch,
 * then store identities, never retarget by a reused position at confirmation
 * time).
 *
 * Refusals are TYPED and PRECISE (each names the fix the model can apply on
 * retry — the `read_message_prompt` unresolved-reference convention): a
 * position from another branch has no row in THIS branch's list, a user
 * message is not an assistant reply, a nonexistent/deleted swipe number has
 * no variant, and a message row whose variant set is missing is refused as
 * the corrupt state it is. The resolver RETURNS refusals; the TOOLS turn
 * them into model-correctable tool failures — never a permission marker
 * that stops the turn for nothing.
 *
 * Pure READS only: no store writes, no generation. The frozen target feeds
 * the two pending proposal payloads (the DMT-11
 * `directorMessageSourceIdentitySchema` identity the apply/save revalidates)
 * and the swipe permission marker.
 */

import type { MessageStore, MessageVariant } from "@vibe-tavern/db";
import type { DirectorMessageSourceIdentity } from "@vibe-tavern/api-contracts";
import { firstLine } from "../agent/kinds/sidechat/sidechat-prompt-read-tools.js";

/** The message reads the resolution runs through — narrowed to the two
 *  methods it needs so tests and callers pass a narrow seam (the prompt-read
 *  tool's store seam, one wiring). */
export type DirectorMessageTargetDeps = Pick<MessageStore, "getMessages" | "getVariantsByBranch">;

/** The reference the model names: the reply's branch position (the
 *  `<rp_message position=…>` number) plus the optional one-based swipe
 *  number (the `<variant number=…>` value). An absent `variantNumber`
 *  means the message's currently SELECTED swipe. */
export interface DirectorMessageTargetRef {
	readonly position: number;
	readonly variantNumber?: number;
}

/** One frozen message/variant identity — the plan's "capture immutable IDs
 *  once" rule. `messageId`/`variantId` are the identity the apply/save
 *  revalidates (DMT-22); `position`/`variantNumber` are display conveniences
 *  the DMT-11 `directorMessageSourceIdentitySchema` also carries. */
export interface DirectorMessageTarget {
	readonly messageId: string;
	readonly variantId: string;
	readonly position: number;
	readonly variantNumber: number;
	/** The swipe's stored content — the review/diff base text. */
	readonly text: string;
	/** The reply's first line — how the user's card names the swipe. */
	readonly replyFirstLine: string;
}

/** Why a reference did not resolve — one precise, model-correctable reason
 *  per shape of mistake (the unit contract's refusal list). */
export type DirectorMessageTargetRefusal =
	/** No row at this position in THIS branch — a position from another
	 *  branch, a deleted reply, or a fabricated number all land here. */
	| { readonly kind: "no_message_at_position"; readonly position: number }
	/** The row exists but is not a committed assistant reply (the editor
	 *  task's own target rule, mirrored). */
	| { readonly kind: "not_an_assistant_reply"; readonly position: number; readonly role: string; readonly state: string }
	/** The message row exists but carries no variant rows — a corrupt or
	 *  incomplete variant set (the store's own invariant broken). */
	| { readonly kind: "no_variants"; readonly position: number; readonly messageId: string }
	/** The named swipe number is not on this message (nonexistent or
	 *  deleted source). */
	| { readonly kind: "no_such_variant"; readonly position: number; readonly variantNumber: number }
	/** The selected swipe was requested but none is flagged. */
	| { readonly kind: "no_selected_variant"; readonly position: number; readonly messageId: string };

/** The refusal's model-facing note — ONE wording per refusal kind, shared
 *  by all three tools (one data source; the tools only prefix their name). */
export function directorMessageTargetRefusalNote(refusal: DirectorMessageTargetRefusal): string {
	switch (refusal.kind) {
		case "no_message_at_position":
			return `no message at position ${refusal.position} in this branch — use a position from this branch's <rp_message position=…> rows`;
		case "not_an_assistant_reply":
			return (
				`the message at position ${refusal.position} is a ${refusal.role} message` +
				(refusal.state === "complete" ? "" : ` in state '${refusal.state}'`) +
				" — corrections, alternatives and regeneration target a committed assistant reply"
			);
		case "no_variants":
			return `the message at position ${refusal.position} carries no swipes — its variant rows are missing, so there is nothing to base a proposal on`;
		case "no_such_variant":
			return `message at position ${refusal.position} has no variant number ${refusal.variantNumber}`;
		case "no_selected_variant":
			return `message at position ${refusal.position} has no selected swipe`;
	}
}

/** A resolution: the frozen target, or the typed refusal. */
export type DirectorMessageTargetResolution =
	| { readonly ok: true; readonly target: DirectorMessageTarget }
	| { readonly ok: false; readonly refusal: DirectorMessageTargetRefusal };

/** The DMT-11 identity shape for a frozen target — what the two proposal
 *  payloads embed as `source`/`sources[]`. */
export function directorMessageSourceIdentityOf(target: DirectorMessageTarget): DirectorMessageSourceIdentity {
	return {
		messageId: target.messageId,
		variantId: target.variantId,
		position: target.position,
		variantNumber: target.variantNumber,
	};
}

/** Load the branch's reply row at `position` with its variant set — the
 *  shared core both public resolutions run through (one position → message
 *  → variants derivation, never a second). */
async function loadBranchTarget(
	deps: DirectorMessageTargetDeps,
	branchId: string,
	position: number,
): Promise<
	| { readonly ok: true; readonly messageId: string; readonly variants: readonly MessageVariant[] }
	| { readonly ok: false; readonly refusal: DirectorMessageTargetRefusal }
> {
	const branchMessages = await deps.getMessages(branchId);
	const message = branchMessages.find((row) => row.position === position);
	if (message === undefined) {
		return { ok: false, refusal: { kind: "no_message_at_position", position } };
	}
	if (message.role !== "assistant" || message.state !== "complete") {
		return {
			ok: false,
			refusal: { kind: "not_an_assistant_reply", position, role: message.role, state: message.state },
		};
	}
	const variants = (await deps.getVariantsByBranch(branchId)).get(message.id) ?? [];
	if (variants.length === 0) {
		return { ok: false, refusal: { kind: "no_variants", position, messageId: message.id } };
	}
	return { ok: true, messageId: message.id, variants };
}

/** Freeze one variant row into the identity the proposals/markers carry. */
function freezeVariant(
	messageId: string,
	position: number,
	variant: { id: string; variantIndex: number; content: string },
): DirectorMessageTarget {
	return {
		messageId,
		variantId: variant.id,
		position,
		variantNumber: variant.variantIndex + 1,
		text: variant.content,
		replyFirstLine: firstLine(variant.content),
	};
}

/**
 * Resolve ONE target: the reply at `position`, its named swipe
 * (`variantNumber`, one-based) or its currently selected swipe when absent.
 * Pure read — no writes, no generation.
 */
export async function resolveDirectorMessageTarget(
	deps: DirectorMessageTargetDeps,
	branchId: string,
	ref: DirectorMessageTargetRef,
): Promise<DirectorMessageTargetResolution> {
	const loaded = await loadBranchTarget(deps, branchId, ref.position);
	if (!loaded.ok) return loaded;
	const variant =
		ref.variantNumber !== undefined
			? loaded.variants.find((row) => row.variantIndex === ref.variantNumber! - 1)
			: loaded.variants.find((row) => row.isSelected);
	if (variant === undefined) {
		return {
			ok: false,
			refusal:
				ref.variantNumber !== undefined
					? { kind: "no_such_variant", position: ref.position, variantNumber: ref.variantNumber }
					: { kind: "no_selected_variant", position: ref.position, messageId: loaded.messageId },
		};
	}
	return { ok: true, target: freezeVariant(loaded.messageId, ref.position, variant) };
}

/**
 * Resolve a SET of named swipes of one reply — the variant-proposal tool's
 * source list (ONE source is valid: this is NOT the merge tool and carries
 * no two-source minimum). Numbers resolve in the given order; a number the
 * message does not carry refuses the whole set (a partial freeze would
 * propose a basis the model misnamed). Pure read.
 */
export async function resolveDirectorMessageSourceSet(
	deps: DirectorMessageTargetDeps,
	branchId: string,
	ref: { readonly position: number; readonly variantNumbers: readonly number[] },
): Promise<
	| { readonly ok: true; readonly messageId: string; readonly sources: readonly DirectorMessageTarget[] }
	| { readonly ok: false; readonly refusal: DirectorMessageTargetRefusal }
> {
	const loaded = await loadBranchTarget(deps, branchId, ref.position);
	if (!loaded.ok) return loaded;
	const sources: DirectorMessageTarget[] = [];
	for (const variantNumber of ref.variantNumbers) {
		const variant = loaded.variants.find((row) => row.variantIndex === variantNumber - 1);
		if (variant === undefined) {
			return { ok: false, refusal: { kind: "no_such_variant", position: ref.position, variantNumber } };
		}
		sources.push(freezeVariant(loaded.messageId, ref.position, variant));
	}
	return { ok: true, messageId: loaded.messageId, sources };
}
