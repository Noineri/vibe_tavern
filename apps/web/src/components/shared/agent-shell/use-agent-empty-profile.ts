import { useEffect, useRef } from "react";
import type { AgentPlan } from "@vibe-tavern/api-contracts";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { TFunc } from "../../../i18n/context.js";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import {
	builtinProfileHandoff,
	builtinProfilePresentation,
	BUILTIN_DIRECTOR_PROFILE_ID,
	type AgentBuiltinProfileHandoff,
	type AgentBuiltinProfilePresentation,
} from "../../../lib/agent-builtin-profiles.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useParkedProfileChoice } from "./use-agent-profile-assignment.js";

/**
 * DR-7 (DIRECTOR_MODE_PLAN, mockup §3): the ACTIVE profile's empty-state
 * presentation + the OOC hand-off row — extracted from `AgentShell`
 * under the file-size ratchet.
 *
 * The shell's OWN `useParkedProfileChoice` instance gives both halves:
 * `effectiveId` picks the active built-in's presentation (the sidechat
 * director's starters/title/subtitle) and `choose` IS the DR-6 write for
 * the hand-off row (never a hand-rolled API call). The chip keeps its own
 * instance — two consumers of the ONE hook; the shared profile store the
 * always-mounted chip loads feeds this instance's loaded-id resolution.
 *
 * Owner ruling 2026-10-27 (binding): EVERY user profile — duplicates of a
 * built-in included — falls back to the HOST's starters; the per-profile
 * presentation applies to built-in profiles only. The hand-off row is
 * offered ONLY while the kind's FIRST built-in is effective (a user profile
 * never shows it) AND the branch plan has no events — the story plan's
 * events are its tasks, and the caller passes the same `useAgentPlan` value
 * the plan section renders from (no second plan read).
 *
 * Script-target hosts run the underlying hook inert (no chat-row read, no
 * write ever fired) and get undefined for both values — their shells render
 * byte-identically to before this unit.
 */
export interface AgentEmptyProfileResult {
	/** The active built-in's own empty state, or undefined (the host's own). */
	emptyPresentation: AgentBuiltinProfilePresentation | undefined;
	/** The OOC hand-off row config + its profile-switch callback, or
	 *  undefined (no row — another profile active, or the plan has events). */
	handoffRow: (AgentBuiltinProfileHandoff & { onActivate: () => void }) | undefined;
}

export function useAgentEmptyProfile({
	kind,
	owner,
	scriptId,
	assignedProfileId,
	plan,
	bumpProfileChip,
	t,
}: {
	/** The registered host kind driving the shell. */
	kind: AgentKind;
	/** The shell's thread owner — chat owners carry the hand-off's chat id. */
	owner: AgentThreadOwner;
	/** The script id for script-target hosts (inert arm). */
	scriptId: string | undefined;
	/** The owner's raw assignment (null = the built-in seed). */
	assignedProfileId: string | null;
	/** The live plan of the shell's plan owner (events = tasks). */
	plan: AgentPlan;
	/** DR-6's chip-remount bump: fired when THIS instance sees the effective
	 *  profile change (the hand-off write), so the chip's once-per-mount
	 *  (chat, kind) read follows the switch. */
	bumpProfileChip: () => void;
	t: TFunc;
}): AgentEmptyProfileResult {
	const host = getAgentHost(kind);
	const isChatTarget = host.profileAssignment.target === "chat";
	const profiles = useCopilotProfileStore((s) => s.profiles);
	const { choose, effectiveId } = useParkedProfileChoice({
		agentKind: kind,
		isChatTarget,
		scriptId,
		chatId: owner.kind === "chat" ? owner.chatId : undefined,
		assignedProfileId,
		profiles,
		// Always true while mounted (the chip's pattern): the empty state
		// needs the (chat, kind) read at rest, not only while a menu is open.
		isOpen: true,
		t,
	});

	// A write through THIS instance (the hand-off row) changes the effective
	// profile behind the chip's once-per-mount read — bump the chip epoch
	// (the DR-6 remount mechanism) so its label follows the switch. The
	// load-time resolution (builtin → a stored choice) rides the same bump
	// harmlessly. `bumpProfileChip` must be stable (the shell's useCallback).
	const prevEffectiveProfileId = useRef(effectiveId);
	useEffect(() => {
		if (prevEffectiveProfileId.current === effectiveId) return;
		prevEffectiveProfileId.current = effectiveId;
		bumpProfileChip();
	}, [effectiveId, bumpProfileChip]);

	const emptyPresentation = builtinProfilePresentation(kind, effectiveId);
	const profileHandoff = builtinProfileHandoff(kind, effectiveId);
	const handoffRow =
		profileHandoff !== undefined && plan.tasks.length === 0
			? { ...profileHandoff, onActivate: () => choose(BUILTIN_DIRECTOR_PROFILE_ID) }
			: undefined;
	return { emptyPresentation, handoffRow };
}
