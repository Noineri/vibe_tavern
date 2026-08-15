import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	aggregateExperienceCopilotProposal,
	type ExperienceCopilotProposal,
} from "../lib/experience-copilot-apply.js";
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";

/**
 * CD-2: the copilot editor's unified review state — per-turn buffer snapshots
 * (checkpoints), the aggregated live proposal over the two buffers, draft-level
 * revert («Отменить изменения»), and manual-edit conflict flags.
 *
 * WHY A HOOK (not a store): the snapshots are editor-session lifetime (they
 * live exactly as long as the shell is mounted for this script) and every input
 * is already owned by the shell as controlled props (`rulesCode` /
 * `visualSource` are the parent editor's draft buffers). No persistence, no
 * cross-component sharing — Zustand would add nothing but a second source of
 * truth for the same texts.
 *
 * Snapshot semantics: a snapshot is taken on the RISING EDGE of `isSending`
 * (turn start) from the CURRENT buffer values. Because the editor is frozen
 * (read-only) while the model works (CD-3), the buffers at proposal time are
 * the same values — the snapshot is therefore both the revert target AND the
 * diff "before" side for the inline review (CD-5/CD-6). Full-snapshot data is
 * written from day one (every turn), so a Cline-style checkpoint timeline can
 * later be built on top without a data migration; this hook's UI surface is
 * only the last-turn revert.
 *
 * Revert is DRAFT-LEVEL: it calls `onRevert` with the snapshot's texts (the
 * shell routes them into the draft stores' onChange), which makes a saved
 * buffer dirty again — Save remains the single point of irreversibility. The
 * revert also dismisses the live turn's activities (`clearTurn`): the pending
 * proposal overlays the reverted text and would otherwise be a wall of
 * conflicts. The turn's audit cards survive in the chat history (CD-1).
 *
 * Conflict flags: `rulesConflict` / `visualConflict` are true when the buffer
 * text has drifted from the turn-start snapshot WHILE a proposal for that
 * buffer is pending — i.e. the user hand-edited during review, so hunk
 * application may no longer overlay (CD-8 resolves flagged hunks explicitly:
 * skipped + toast, never a silent rebase).
 */
export interface CopilotReviewSnapshot {
	/** Monotonic per-hook-instance id (turn order). */
	id: number;
	rules: string;
	visual: string;
}

export interface UseCopilotReviewStateArgs {
	/** Changing this key resets the snapshot stack (one editor = one script). */
	resetKey: string;
	/** The copilot thread whose live activities carry the pending proposal. */
	threadId: string;
	/** True while the model is generating (the snapshot trigger). */
	isSending: boolean;
	/** Live rules draft buffer (controlled by the parent editor). */
	rulesCode: string;
	/** Live visual draft buffer (controlled by the parent editor). */
	visualSource: string;
	/** The live turn's tool activities (already store-subscribed by the caller;
	 *  passed in so this hook stays store-free and trivially testable). */
	activities: ReadonlyArray<ExperienceCopilotToolActivity>;
	/** Applies the snapshot's texts to the draft buffers (shell → onChange). */
	onRevert: (buffers: { rules: string; visual: string }) => void;
}

export interface CopilotReviewState {
	/** All snapshots this editor session took (oldest first, for a future
	 *  checkpoint timeline; the revert UI reads only the last one). */
	snapshots: CopilotReviewSnapshot[];
	/** The current revert target (null before the first turn). */
	lastSnapshot: CopilotReviewSnapshot | null;
	/** True when the buffers differ from the last snapshot — revert is meaningful. */
	canRevert: boolean;
	/** Revert the draft buffers to the last snapshot and dismiss the pending
	 *  proposal. No-op when `canRevert` is false. */
	revertLastTurn: () => void;
	/** Aggregated live proposal (last-wins per buffer over `activities`). */
	proposal: ExperienceCopilotProposal;
	/** The diff "before" side for the pending proposal = the turn-start
	 *  snapshot (the editor is frozen while the model works, so they coincide).
	 *  Null when no snapshot exists yet. */
	proposalBase: { rules: string; visual: string } | null;
	/** Per-buffer manual-edit-during-review flags (see module comment). */
	rulesConflict: boolean;
	visualConflict: boolean;
}

export function useCopilotReviewState({
	resetKey,
	threadId,
	isSending,
	rulesCode,
	visualSource,
	activities,
	onRevert,
}: UseCopilotReviewStateArgs): CopilotReviewState {
	const [snapshots, setSnapshots] = useState<CopilotReviewSnapshot[]>([]);
	const nextIdRef = useRef(1);

	// Live buffer refs so the snapshot effect depends ONLY on `isSending` (a
	// keystroke must not re-run the edge detector, and the snapshot must read
	// the values current at the moment the turn actually starts).
	const rulesRef = useRef(rulesCode);
	rulesRef.current = rulesCode;
	const visualRef = useRef(visualSource);
	visualRef.current = visualSource;

	const prevSendingRef = useRef(isSending);
	useEffect(() => {
		const was = prevSendingRef.current;
		prevSendingRef.current = isSending;
		if (isSending && !was) {
			const id = nextIdRef.current++;
			const rules = rulesRef.current;
			const visual = visualRef.current;
			setSnapshots((s) => [...s, { id, rules, visual }]);
		}
	}, [isSending]);

	// Editor switch (different script): the snapshot stack describes OTHER
	// buffers — drop it. Runs on mount too (no-op on the initial empty stack).
	useEffect(() => {
		setSnapshots([]);
		nextIdRef.current = 1;
	}, [resetKey]);

	const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;

	const revertLastTurn = useCallback(() => {
		const snapshot = snapshots[snapshots.length - 1];
		if (!snapshot) return;
		onRevert({ rules: snapshot.rules, visual: snapshot.visual });
		setSnapshots((s) => s.slice(0, -1));
		// Dismiss the pending proposal: it was diffed against the pre-turn
		// buffers and cannot be meaningfully applied over the reverted text.
		useExperienceCopilotTurnStore.getState().clearTurn(threadId);
	}, [snapshots, onRevert, threadId]);

	const proposal = useMemo(
		() => aggregateExperienceCopilotProposal(activities),
		[activities],
	);

	const proposalBase =
		lastSnapshot !== null ? { rules: lastSnapshot.rules, visual: lastSnapshot.visual } : null;

	const canRevert =
		lastSnapshot !== null &&
		(rulesCode !== lastSnapshot.rules || visualSource !== lastSnapshot.visual);

	const rulesConflict =
		proposal.proposedRules !== undefined &&
		lastSnapshot !== null &&
		rulesCode !== lastSnapshot.rules;
	const visualConflict =
		proposal.proposedVisual !== undefined &&
		lastSnapshot !== null &&
		visualSource !== lastSnapshot.visual;

	return {
		snapshots,
		lastSnapshot,
		canRevert,
		revertLastTurn,
		proposal,
		proposalBase,
		rulesConflict,
		visualConflict,
	};
}
