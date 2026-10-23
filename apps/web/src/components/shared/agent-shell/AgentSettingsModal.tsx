import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { Modal } from "../Modal.js";
import { modalPanelCls } from "../modal-helpers.js";
import { Icons } from "../icons.js";
import { Toggle } from "../Toggle.js";
import { DropdownSelect } from "../DropdownSelect.js";
import { AgentModelPills } from "./AgentModelPills.js";
import { AgentProfileModal } from "./AgentProfileModal.js";
import { AgentSkillModal } from "./AgentSkillModal.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useCopilotSkillStore } from "../../../stores/copilot-skill-store.js";
import { patchAgentKindSettingsAction, useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useAgentProfileAssignment } from "./use-agent-profile-assignment.js";

/**
 * Assistant settings summary (AGENT_SHELL_POLISH AP-27, mockup §4) — the
 * gear's modal, parent of the existing profile + skill modals. Four rows,
 * each = icon, title, one-line muted subtitle, control on the right,
 * divided by hairlines:
 *
 * - Profile: a compact dropdown showing the assignment hook's EFFECTIVE
 *   profile (kind default resolution + assignment writes, shared with the
 *   profile modal's primary action) + an «Edit profiles ›» link opening
 *   `AgentProfileModal` as a child;
 * - Model: `AgentModelPills` with the composer's binding (the subtitle says
 *   it IS the same state);
 * - Auto-compact: a `Toggle` for the kind-level NEW-session default
 *   (AP-20: null = on); the subtitle points at the current session's
 *   context-meter «Auto» switch instead of duplicating it;
 * - Skills: the builtin/user counts («open the library ›» opens the host's
 *   `AgentSkillModal`).
 *
 * Children open OVER the summary with `parentBack` «Настройки помощника»;
 * back returns to the summary (never closes it). CONTROLLED — open/close
 * are props, owned by `AgentShell` (the gear), like the profile modal was.
 */
export interface AgentSettingsModalProps {
	/** The agent kind whose settings this summary manages (AS-8b). */
	agentKind: AgentKind;
	/** SC-13a: the script a script-target host writes (unreachable for chat hosts). */
	scriptId?: string;
	/** SC-0g: the chat a chat-target host writes (ignored by script hosts). */
	chatId?: string;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	/** The composer's model binding (AP-26) — the row renders the same state. */
	providerProfileId: string | null;
	model?: string;
	onProviderChange: (profileId: string, model?: string) => void;
	isOpen: boolean;
	onClose: () => void;
}

export function AgentSettingsModal({
	agentKind,
	scriptId,
	chatId,
	assignedProfileId,
	providerProfileId,
	model,
	onProviderChange,
	isOpen,
	onClose,
}: AgentSettingsModalProps) {
	const { t } = useT();
	const isMobile = useIsMobile();
	const host = getAgentHost(agentKind);
	// SC-0g: the row renders its assignment variant purely from the host
	// descriptor — no kind literal here (same branch as the profile modal).
	const isChatTarget = host.profileAssignment.target === "chat";

	const profiles = useCopilotProfileStore((s) => s.profiles);
	const profilesLoaded = useCopilotProfileStore((s) => s.hasLoaded);
	const loadProfiles = useCopilotProfileStore((s) => s.load);
	const skillEntries = useCopilotSkillStore((s) => s.catalogs[agentKind]?.entries);
	const loadSkills = useCopilotSkillStore((s) => s.load);
	// AP-20: the kind-level default for NEW sessions (the store resolves the
	// stored NULL — on, the pre-AP-20 effective behavior — to `true` at
	// read; absent bootstrap entry reads the same).
	const autoCompactDefault = useBootstrapStore((s) => s.data?.agentKindSettings?.[agentKind]?.autoCompactDefault) ?? true;

	const [profileOpen, setProfileOpen] = useState(false);
	const [skillOpen, setSkillOpen] = useState(false);
	// The dropdown is one-step (choose = apply) while the assignment hook is
	// two-step (select, then assign): the choice parks here and the commit
	// effect below applies it through the hook once the target resolves.
	// A FAILED write resets the park (see `onFailed`) so the trigger shows
	// the effective profile again and choosing the same profile retries.
	const [chosenId, setChosenId] = useState<string | null>(null);
	// The commit edge pins the committed choice (see below) — the hook
	// object is fresh every render, so without it the effect would re-fire
	// the write on every parent re-render until the server round-trip
	// clears the choice. Reset on failure and on close (a stale pin would
	// swallow a same-profile retry, even in a later modal session).
	const committedRef = useRef<string | null>(null);

	useEffect(() => {
		if (isOpen) {
			void loadProfiles(agentKind);
			void loadSkills(agentKind);
		}
		if (!isOpen) {
			setProfileOpen(false);
			setSkillOpen(false);
			setChosenId(null);
			committedRef.current = null;
		}
	}, [isOpen, agentKind, loadProfiles, loadSkills]);

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

	const handleAutoCompact = (enabled: boolean) => {
		// SC-0e: the write merges the returned row into the bootstrap
		// kind-settings map, so sibling subscribers update immediately.
		void patchAgentKindSettingsAction(agentKind, { autoCompactDefault: enabled }).catch(() => {
			toast.error(t("copilot_context_auto_toggle_error"));
		});
	};

	const entries = skillEntries ?? [];
	const builtinCount = entries.filter((e) => e.source === "builtin").length;
	const customCount = entries.filter((e) => e.source === "user").length;
	// Each non-zero part renders through its own plural-aware key (the
	// sidechat_event_rp_sync shape — base + _one/_few/_many/_other, `count`
	// at the call site); a zero part is left out, both-zero keeps the empty
	// line.
	const skillParts: string[] = [];
	if (builtinCount > 0) skillParts.push(t("agent_settings_skills_builtin", { n: builtinCount, count: builtinCount }));
	if (customCount > 0) skillParts.push(t("agent_settings_skills_custom", { n: customCount, count: customCount }));

	return (
		<>
			<Modal open={isOpen} onClose={onClose} title={t("agent_settings_title")}>
				<div
					className={cn(
						"flex flex-col",
						isMobile
							? "glass-blur-under h-full w-full overflow-hidden"
							: cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[640px] max-w-[calc(100vw-32px)]"),
					)}
					onClick={(e) => e.stopPropagation()}
				>
					<div className={cn("shrink-0 border-b border-border", isMobile ? "px-4 pb-3 pt-4" : "px-6 pb-4 pt-5")}>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<h2 data-testid="agent-settings-title" className="font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">
									{t("agent_settings_title")}
								</h2>
								<p data-testid="agent-settings-subtitle" className="mt-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
									{t(host.i18n.kindLabel)}
								</p>
							</div>
							<button
								type="button"
								aria-label={t("close")}
								className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1"
								onClick={onClose}
							>
								<Icons.Close />
							</button>
						</div>
					</div>
					<div className={cn("min-h-0 flex-1 overflow-y-auto", isMobile ? "px-4 py-2" : "px-6 py-2")}>
						<SettingsRow
							testId="agent-settings-row-profile"
							icon={<Icons.User className="h-[18px] w-[18px]" />}
							title={t("agent_settings_profile")}
							sub={t("agent_settings_profile_sub")}
							control={
								<>
									<DropdownSelect
										value={chosenId ?? effectiveId}
										options={profiles.map((p) => ({ id: p.id, label: p.name }))}
										onChange={(id) => setChosenId(id)}
										disabled={!profilesLoaded || profiles.length === 0}
										searchable={false}
										triggerTestId="agent-settings-profile-select"
										triggerClassName="flex h-8 min-w-0 max-w-[160px] items-center gap-1.5 rounded-[5px] bg-s2 px-2.5 font-ui text-[calc(var(--ui-fs)-1.5px)] text-t1 transition-colors hover:bg-s3"
									/>
									<button
										type="button"
										data-testid="agent-settings-edit-profiles-btn"
										className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
										onClick={() => setProfileOpen(true)}
									>
										{t("agent_settings_edit_profiles")}
									</button>
								</>
							}
						/>
						<SettingsRow
							testId="agent-settings-row-model"
							icon={<Icons.Sparkles className="h-[18px] w-[18px]" />}
							title={t("agent_settings_model")}
							sub={t("agent_settings_model_sub")}
							control={
								<AgentModelPills mobile={isMobile} providerProfileId={providerProfileId} model={model} onProviderChange={onProviderChange} />
							}
						/>
						<SettingsRow
							testId="agent-settings-row-autocompact"
							icon={<Icons.Stack className="h-[18px] w-[18px]" />}
							title={t("agent_settings_autocompact")}
							sub={t("agent_settings_autocompact_sub")}
							control={
								<Toggle
									checked={autoCompactDefault}
									onChange={handleAutoCompact}
									aria-label={t("agent_settings_autocompact")}
								/>
							}
						/>
						<SettingsRow
							testId="agent-settings-row-skills"
							icon={<Icons.Book className="h-[18px] w-[18px]" />}
							title={t("agent_settings_skills")}
							sub={skillParts.length > 0 ? skillParts.join(" · ") : t("agent_settings_no_skills")}
							control={
								<button
									type="button"
									data-testid="agent-settings-open-library-btn"
									className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
									onClick={() => setSkillOpen(true)}
								>
									{t("agent_settings_open_library")}
								</button>
							}
						/>
					</div>
				</div>
			</Modal>
			<AgentProfileModal
				scriptId={scriptId}
				chatId={chatId}
				agentKind={agentKind}
				assignedProfileId={assignedProfileId}
				isOpen={profileOpen}
				onClose={() => setProfileOpen(false)}
				parentBack={{ label: t("agent_settings_title"), onBack: () => setProfileOpen(false) }}
			/>
			<AgentSkillModal
				isOpen={skillOpen}
				onClose={() => setSkillOpen(false)}
				agentKind={agentKind}
				parentBack={{ label: t("agent_settings_title"), onBack: () => setSkillOpen(false) }}
			/>
		</>
	);
}

// ─── One summary row (icon + title + muted line, control on the right) ───

interface SettingsRowProps {
	testId: string;
	icon: React.ReactNode;
	title: string;
	sub: string;
	control: React.ReactNode;
}

function SettingsRow({ testId, icon, title, sub, control }: SettingsRowProps) {
	return (
		<div data-testid={testId} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0">
			<span className="flex shrink-0 text-t3">{icon}</span>
			<span className="min-w-0 flex-1 basis-40">
				<span className="block font-ui text-t1">{title}</span>
				<span className="block font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{sub}</span>
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-2">{control}</span>
		</div>
	);
}
