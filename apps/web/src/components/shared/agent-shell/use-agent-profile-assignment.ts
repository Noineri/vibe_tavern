import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import { setCopilotProfile } from "../../../api/copilot-profile-api.js";
import { getAgentChatSettings, patchAgentChatSettings } from "../../../api/agent-chat-settings-api.js";
import { patchAgentKindSettingsAction, useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import type { TFunc } from "../../../i18n/context.js";
import { BUILTIN_PROFILE_ID } from "../../../lib/agent-builtin-profiles.js";

/**
 * Assignment logic for `AgentProfileModal` (AP-24 extraction — AP-27 reuses
 * this hook unchanged for the settings-summary profile dropdown, which writes
 * exactly what the modal's primary action writes). Pure move from the modal:
 * the script write (`scripts.copilotProfileId` via `setCopilotProfile`,
 * built-in → null = unassign) and the two chat writes (the (chat, kind) row
 * "use here" — the built-in row pins the literal sentinel so the chat runs
 * the seed even under a custom default — and the kind default "use by
 * default" — the built-in clears it). Failures reuse the assignment error
 * copy and report through the optional `onFailed` (AP-27 follow-up: the
 * settings summary's one-step dropdown parks its choice outside the hook,
 * so it needs the failure signal to unpark); every success closes the
 * modal through `onAssigned`.
 *
 * The module also exports `useParkedProfileChoice` — the one-step
 * (dropdown / menu) adapter that parks a choice and commits it through
 * the hook above; see that hook's header for its provenance.
 */

/**
 * The first built-in profile's id sentinel — "builtin" (a stored null
 * assignment resolves to the seed; a chat row pinning it pins the seed).
 * Defined in `lib/agent-builtin-profiles.ts` (DR-7) so the sidechat
 * built-in derivations and this hook share ONE spelling; re-exported here
 * for the existing importers.
 */
export { BUILTIN_PROFILE_ID };

/**
 * The effective profile id for a chat-target modal (SC-0k) — the modal-side
 * mirror of `CopilotProfileResolver.resolveForChat` (same hop order): the
 * chat's own choice when it resolves (the built-in sentinel always resolves;
 * a stored custom id resolves when its row is in the loaded list) → the
 * kind default when it resolves (a built-in default reads as null) → the
 * built-in seed. Dangling ids fall through, never mark a missing row.
 */
export function resolveChatEffectiveProfileId(
	chatProfileId: string | null,
	kindDefaultProfileId: string | null,
	loadedProfileIds: ReadonlySet<string>,
): string {
	if (chatProfileId !== null && (chatProfileId === BUILTIN_PROFILE_ID || loadedProfileIds.has(chatProfileId))) {
		return chatProfileId;
	}
	if (
		kindDefaultProfileId !== null &&
		kindDefaultProfileId !== BUILTIN_PROFILE_ID &&
		loadedProfileIds.has(kindDefaultProfileId)
	) {
		return kindDefaultProfileId;
	}
	return BUILTIN_PROFILE_ID;
}

export interface AgentProfileAssignmentInput {
	/** The agent kind whose profiles this instance manages (AS-8b). */
	agentKind: string;
	/** True when the host's `profileAssignment` targets `"chat"` (sidechat). */
	isChatTarget: boolean;
	/** SC-13a: the script a script-target host writes (unreachable for chat hosts). */
	scriptId?: string;
	/** SC-0g: the chat a chat-target host writes (ignored by script hosts). */
	chatId?: string;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	/** The currently selected row (the assignment target), or null. */
	selected: CopilotProfile | null;
	/** The loaded profiles (the SC-0k chain resolves custom ids against these). */
	profiles: CopilotProfile[];
	/** Controlled-open flag — the chat-row read runs on open, resets on close. */
	isOpen: boolean;
	t: TFunc;
	onAssigned: () => void;
	/** Failure signal for one-step callers (the settings summary dropdown)
	 *  that park their choice outside the hook — lets them unpark on a
	 *  failed write so the control shows the effective profile again and a
	 *  same-choice retry re-fires. Two-step callers (the profile modal)
	 *  keep their selection and omit this. */
	onFailed?: () => void;
}

export interface AgentProfileAssignment {
	/** Script-path mirror of the resolver's null→builtin fallback (list mark). */
	activeProfileId: string;
	/** SC-0k: the EFFECTIVE profile id for chat-target hosts (list mark). */
	chatEffectiveProfileId: string;
	/** SC-0g: the kind-default profile id — undefined = script host (no badge). */
	defaultProfileId: string | null | undefined;
	isSelectedActive: boolean;
	isSelectedHere: boolean;
	isSelectedDefault: boolean;
	assign: () => void;
	assignHere: () => void;
	assignDefault: () => void;
}

export function useAgentProfileAssignment({
	agentKind,
	isChatTarget,
	scriptId,
	chatId,
	assignedProfileId,
	selected,
	profiles,
	isOpen,
	t,
	onAssigned,
	onFailed,
}: AgentProfileAssignmentInput): AgentProfileAssignment {
	// Mirror the resolver's null→builtin fallback so the active row is marked
	// even when nothing has been explicitly assigned yet.
	const activeProfileId = assignedProfileId ?? BUILTIN_PROFILE_ID;

	// SC-0g (chat-target hosts only): the chat row's own choice, read via the
	// SC-0f client on open (null = no override — the kind default applies).
	// The kind-wide default comes from the bootstrap kind-settings map (SC-0e).
	const [chatProfileId, setChatProfileId] = useState<string | null>(null);
	const kindDefaultProfileId = useBootstrapStore((s) => s.data?.agentKindSettings?.[agentKind]?.defaultProfileId) ?? null;

	useEffect(() => {
		if (isOpen) {
			// SC-0g: a chat-target host reads the chat row's own choice on
			// open (a missing row resolves to null — no override). A failed
			// read keeps null (the kind default applies); writes still
			// surface errors.
			if (isChatTarget && chatId !== undefined) {
				void getAgentChatSettings(chatId, agentKind).then(
					(w) => setChatProfileId(w.profileId),
					() => setChatProfileId(null),
				);
			}
		}
		if (!isOpen) {
			setChatProfileId(null);
		}
	}, [isOpen, isChatTarget, chatId, agentKind]);

	// SC-0k: chat-target hosts mark the EFFECTIVE profile (the one the server
	// chain resolves for this chat) — not the raw chat-row choice. Script
	// hosts keep the assignment mirror above.
	const chatEffectiveProfileId = resolveChatEffectiveProfileId(
		chatProfileId,
		kindDefaultProfileId,
		new Set(profiles.map((p) => p.id)),
	);

	const isSelectedActive = selected !== null && selected.id === activeProfileId;
	// SC-0g/SC-0k (chat-target hosts only): the two writes — the (chat, kind)
	// row ("use here") and the kind default ("use by default"). SC-0k: "use
	// here" on the built-in pins the literal sentinel (the chat runs the seed
	// even under a custom default); null keeps meaning "no own choice —
	// follow the default". "Use by default" on the built-in still clears
	// the default (null — a built-in default reads the same). The script
	// path's unassign (built-in → null) is unchanged.
	const isSelectedHere = selected !== null && selected.id === chatProfileId;
	const isSelectedDefault = selected !== null && (selected.id === BUILTIN_PROFILE_ID
		? kindDefaultProfileId === null || kindDefaultProfileId === BUILTIN_PROFILE_ID
		: selected.id === kindDefaultProfileId);

	const assign = () => {
		if (!selected || isSelectedActive || scriptId === undefined) return;
		void (async () => {
			try {
				// Built-in = unassign (null); a user profile = its id.
				await setCopilotProfile(scriptId, selected.id === BUILTIN_PROFILE_ID ? null : selected.id);
				onAssigned();
			} catch {
				toast.error(t("copilot_profile_assign_failed"));
				onFailed?.();
			}
		})();
	};

	const assignHere = () => {
		if (!selected || isSelectedHere || chatId === undefined) return;
		void (async () => {
			try {
				// SC-0k: the selected id is written verbatim — the built-in
				// row's id IS the sentinel, so pinning it stores "builtin"
				// (null keeps meaning "no own choice").
				const updated = await patchAgentChatSettings(chatId, agentKind, {
					profileId: selected.id,
				});
				setChatProfileId(updated.profileId);
				onAssigned();
			} catch {
				toast.error(t("copilot_profile_assign_failed"));
				onFailed?.();
			}
		})();
	};

	const assignDefault = () => {
		if (!selected || isSelectedDefault) return;
		void (async () => {
			try {
				// The action merges the returned row into the bootstrap
				// kind-settings map, so sibling subscribers update immediately.
				await patchAgentKindSettingsAction(agentKind, {
					defaultProfileId: selected.id === BUILTIN_PROFILE_ID ? null : selected.id,
				});
				onAssigned();
			} catch {
				toast.error(t("copilot_profile_assign_failed"));
				onFailed?.();
			}
		})();
	};

	return {
		activeProfileId,
		chatEffectiveProfileId,
		// SC-0g: script hosts leave this undefined (no extra badge); a
		// chat-target host passes the raw kind default (possibly null); null
		// marks the built-in seed, mirroring the script null→builtin fallback.
		defaultProfileId: isChatTarget ? kindDefaultProfileId : undefined,
		isSelectedActive,
		isSelectedHere,
		isSelectedDefault,
		assign,
		assignHere,
		assignDefault,
	};
}

// ─── One-step parked choice (dropdowns / menus) ────────────────────────

export interface ParkedProfileChoiceInput {
	/** The agent kind whose profiles this instance manages (AS-8b). */
	agentKind: string;
	/** True when the host's `profileAssignment` targets `"chat"` (sidechat). */
	isChatTarget: boolean;
	/** SC-13a: the script a script-target host writes (unreachable for chat hosts). */
	scriptId?: string;
	/** SC-0g: the chat a chat-target host writes (ignored by script hosts). */
	chatId?: string;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	/** The loaded profiles (the commit guard resolves the parked id against these). */
	profiles: CopilotProfile[];
	/** Controlled-open flag, passed through to `useAgentProfileAssignment` (the
	 *  chat-row read runs on open, resets on close) and driving the parked
	 *  choice's own close reset below. Always-open consumers pass literal
	 *  `true` — the close reset then never fires. */
	isOpen: boolean;
	t: TFunc;
}

export interface ParkedProfileChoice {
	/** The parked (in-flight) choice id, or null (render the effective id). */
	chosenId: string | null;
	/** Parks a choice (the dropdown pick / menu row); the commit effect applies it. */
	choose: (id: string) => void;
	/** The EFFECTIVE profile id for the host's variant: `chatEffectiveProfileId`
	 *  for chat-target hosts, the assignment mirror `activeProfileId` otherwise. */
	effectiveId: string;
}

/**
 * The one-step parked-profile-choice adapter over `useAgentProfileAssignment`.
 *
 * PROVENANCE — extracted from `AgentSettingsModal`'s inline parked-choice
 * pattern (AP-27, the settings summary's profile dropdown);
 * `AgentProfileChip` (DR-6) carried copy #2; unified by owner unit 2026-10-27
 * (DIRECTOR_MODE_PLAN.md DR-6b — see its execution log). `AgentProfileModal`
 * is NOT a consumer: its footer is the two-step surface (select, then the
 * explicit Assign button) this hook adapts FOR one-step controls
 * (dropdowns, menus).
 *
 * WHY IT OWNS THE `useAgentProfileAssignment` CALL — the parking state and
 * the assignment callbacks are mutually recursive (`onAssigned` unparks,
 * `onFailed` resets the pin + unparks), so the seam passes the hook's own
 * inputs and this adapter wires everything: consumers get back exactly the
 * three values both of them render (`chosenId`, `choose`, `effectiveId`).
 */
export function useParkedProfileChoice({
	agentKind,
	isChatTarget,
	scriptId,
	chatId,
	assignedProfileId,
	profiles,
	isOpen,
	t,
}: ParkedProfileChoiceInput): ParkedProfileChoice {
	// The consumer's control is one-step (choose = apply) while the
	// assignment hook is two-step (select, then assign): the choice parks
	// here and the commit effect below applies it through the hook once the
	// target resolves. A FAILED write resets the park (see `onFailed`) so
	// the control shows the effective profile again and choosing the same
	// profile retries.
	const [chosenId, setChosenId] = useState<string | null>(null);
	// The commit edge pins the committed choice (see below) — the hook
	// object is fresh every render, so without it the effect would re-fire
	// the write on every parent re-render until the server round-trip
	// clears the choice. Reset on failure and on close (a stale pin would
	// swallow a same-profile retry, even in a later modal session).
	const committedRef = useRef<string | null>(null);

	// The close reset (AgentSettingsModal's former `!isOpen` branch): a
	// closing consumer unparks and clears the pin; always-open consumers
	// (isOpen constant true) never fire it.
	useEffect(() => {
		if (!isOpen) {
			setChosenId(null);
			committedRef.current = null;
		}
	}, [isOpen]);

	// No in-flight choice: pass null (the hook's guards no-op on null, and
	// neither resolution read below depends on the selection).
	const selected = chosenId !== null ? (profiles.find((p) => p.id === chosenId) ?? null) : null;
	const assignment = useAgentProfileAssignment({
		agentKind,
		isChatTarget,
		scriptId,
		chatId,
		assignedProfileId,
		selected,
		profiles,
		isOpen,
		t,
		onAssigned: () => setChosenId(null),
		onFailed: () => {
			committedRef.current = null;
			setChosenId(null);
		},
	});
	const effectiveId = isChatTarget ? assignment.chatEffectiveProfileId : assignment.activeProfileId;

	// The commit edge (see `chosenId` above): guards + writes live in the
	// hook (`assign` / `assignHere` no-op when the choice is already active).
	useEffect(() => {
		if (chosenId === null || chosenId === committedRef.current) return;
		if (!profiles.some((p) => p.id === chosenId)) return;
		committedRef.current = chosenId;
		if (isChatTarget) assignment.assignHere();
		else assignment.assign();
	}, [chosenId, profiles, isChatTarget, assignment]);

	return { chosenId, choose: setChosenId, effectiveId };
}
