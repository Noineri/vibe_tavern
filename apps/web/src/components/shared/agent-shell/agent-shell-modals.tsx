import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { AgentSettingsModal } from "./AgentSettingsModal.js";
import { AgentProfileModal } from "./AgentProfileModal.js";

/**
 * The shell's TWO toolbar modal mounts — extracted from `AgentShell.tsx` at
 * the file-size ratchet (DR-8; a pure move, same components + props):
 *
 *  - AP-27: the gear's settings summary (`AgentSettingsModal`), whose skills
 *    row opens the skill library and whose profile row opens the profiles
 *    modal as a CHILD (with `parentBack` — that child mount lives inside
 *    `AgentSettingsModal` itself, never here);
 *  - DR-6: the header profile chip's STANDALONE profiles modal
 *    (`AgentProfileModal`, no `parentBack` — it was not opened from a
 *    settings surface), beside the summary's child one; only one is ever
 *    open.
 *
 * Open/close stay CONTROLLED by the shell (the gear / the chip own the
 * flags); both `onClose` props are expected to also bump the shell's
 * profile-chip read epoch — either modal's footers may have written the
 * (chat, kind) row behind the chip's once-per-mount read.
 *
 * History carried over from the shell (XU-5/XU-6): the preview moved OUT of
 * a modal into the editor's default tab (the inline `ExperienceFrame`), the
 * sandbox became the inline Try tab in BOTH modes (quote 10), and the rules
 * tester was absorbed into the sandbox's diagnostics (XU-4) — so no sandbox
 * modal remains; the profile + skill modals open as the summary's children
 * (with parentBack), never from here.
 */
export interface AgentShellModalsProps {
	agentKind: AgentKind;
	/** SC-13a: the script id for script-target hosts (undefined for chats). */
	scriptId: string | undefined;
	/** SC-0g: the chat id for chat-target hosts (undefined for scripts). */
	chatId: string | undefined;
	/** The profile currently assigned to this owner, or null (built-in seed). */
	assignedProfileId: string | null;
	/** The composer's model binding (the settings summary's model row renders
	 *  the same state; the hook may hold an own profile model's pair). */
	providerProfileId: string | null;
	model: string | undefined;
	onProviderChange: (profileId: string, nextModel?: string) => void;
	/** DR-8: the pair the composer's pills show right now — the profiles
	 *  modal's own-segment reveal starting point (mockup §11). */
	currentModel: { providerProfileId: string | null; model?: string };
	settingsOpen: boolean;
	profileOpen: boolean;
	onSettingsClose: () => void;
	onProfileClose: () => void;
}

export function AgentShellModals({
	agentKind,
	scriptId,
	chatId,
	assignedProfileId,
	providerProfileId,
	model,
	onProviderChange,
	currentModel,
	settingsOpen,
	profileOpen,
	onSettingsClose,
	onProfileClose,
}: AgentShellModalsProps) {
	return (
		<>
			<AgentSettingsModal
				agentKind={agentKind}
				scriptId={scriptId}
				chatId={chatId}
				assignedProfileId={assignedProfileId}
				providerProfileId={providerProfileId}
				model={model}
				onProviderChange={onProviderChange}
				isOpen={settingsOpen}
				onClose={onSettingsClose}
			/>
			{/* DR-6: the chip's standalone profiles modal (see `profileOpen`).
			    The close also bumps the chip epoch — the modal's footers may
			    have written the chat row behind the chip's back. */}
			<AgentProfileModal
				scriptId={scriptId}
				chatId={chatId}
				agentKind={agentKind}
				assignedProfileId={assignedProfileId}
				currentModel={currentModel}
				isOpen={profileOpen}
				onClose={onProfileClose}
			/>
		</>
	);
}
