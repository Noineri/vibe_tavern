import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import { setCopilotProfile } from "../../../api/copilot-profile-api.js";
import { getAgentChatSettings, patchAgentChatSettings } from "../../../api/agent-chat-settings-api.js";
import { patchAgentKindSettingsAction, useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import type { TFunc } from "../../../i18n/context.js";

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
 */
export const BUILTIN_PROFILE_ID = "builtin";

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
