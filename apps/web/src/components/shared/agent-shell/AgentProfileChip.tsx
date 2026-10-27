import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../icons.js";
import { MasterListTag } from "../master-list/master-list-tag.js";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { BUILTIN_PROFILE_ID, useAgentProfileAssignment } from "./use-agent-profile-assignment.js";

/**
 * AgentProfileChip (DIRECTOR_MODE_PLAN DR-6, mockup §2) — the header's
 * profile label: an accent-dim pill showing WHICH profile answers, between
 * the session switcher and the context ring. Hidden while the effective
 * profile is the kind's first built-in (the seed — its id is the
 * BUILTIN_PROFILE_ID sentinel), so the default header renders
 * byte-identical to the pre-DR-6 row; shown for every other effective
 * profile (another built-in, such as the director, or a user profile).
 * The pill NEVER truncates (`whitespace-nowrap` + `shrink-0` — the session
 * name yields first).
 *
 * WRITE SURFACE — the THIRD consumer of the parked-choice pattern (the
 * profile modal was the first, the settings summary's dropdown the second):
 * the choice parks in `chosenId`, a commit effect applies it through
 * `useAgentProfileAssignment` (`assignHere` for chat-target hosts, `assign`
 * for script hosts — exactly what the settings summary's profile dropdown
 * writes today), and `onFailed` unparks so a failed write falls back to
 * the effective profile and a same-choice retry re-fires. Unlike the modal
 * consumers, the chip
 * keeps the hook's `isOpen` true for its whole mounted life: the LABEL
 * needs the chat row's effective profile at rest, not only while a menu is
 * open. Sibling surfaces (settings summary, profiles modal) write through
 * their own hook instances, which this instance cannot see — the shell
 * remounts the chip (fresh read) each time one of them closes, so the
 * label never goes stale.
 *
 * CHROME — the pill is mockup §2's `pchip`; the menu rides the SAME-ROW
 * canon: `AgentSessionSwitcher`'s Radix popover chrome, which also makes it
 * viewport-agnostic (that popover serves the identical header row on the
 * phone and on desktop — no mobile-specific shape). Origin tags render
 * through `MasterListTag` (the one text-tag shape). CONTROLLED popover: a
 * pick applies and closes; the edit-profiles row
 * (`agent_settings_edit_profiles`) closes and hands off to
 * the shell's `AgentProfileModal` mount.
 */
export interface AgentProfileChipProps {
	/** The agent kind whose profiles this chip lists (AS-8b host descriptor). */
	agentKind: AgentKind;
	/** SC-13a: the script a script-target host writes (unreachable for chat hosts). */
	scriptId?: string;
	/** SC-0g: the chat a chat-target host writes (ignored by script hosts). */
	chatId?: string;
	/** The profile currently assigned to this owner, or null (built-in seed). */
	assignedProfileId: string | null;
	/** DR-6: opens the profiles management modal (the shell owns the mount). */
	onOpenProfiles: () => void;
}

export function AgentProfileChip({
	agentKind,
	scriptId,
	chatId,
	assignedProfileId,
	onOpenProfiles,
}: AgentProfileChipProps) {
	const { t } = useT();
	const host = getAgentHost(agentKind);
	// The assignment variant renders purely from the host descriptor — no
	// kind literal here (the same branch as the settings summary + modal).
	const isChatTarget = host.profileAssignment.target === "chat";

	const profiles = useCopilotProfileStore((s) => s.profiles);
	const loadProfiles = useCopilotProfileStore((s) => s.load);
	// The chip is always mounted in the header, so it triggers the list
	// load itself; the shared store caches it for the modals (and theirs
	// refresh it through the same `load`).
	useEffect(() => {
		void loadProfiles(agentKind);
	}, [agentKind, loadProfiles]);

	// The parked choice + its commit pin (the settings-summary pattern,
	// verbatim): the menu is one-step (choose = apply) while the hook is
	// two-step (select, then assign). A FAILED write resets the park so the
	// label shows the effective profile again and re-choosing retries.
	const [chosenId, setChosenId] = useState<string | null>(null);
	const committedRef = useRef<string | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);

	// No in-flight choice: pass null (the hook's guards no-op on null, and
	// the effective resolution below does not depend on the selection).
	const selected = chosenId !== null ? (profiles.find((p) => p.id === chosenId) ?? null) : null;
	const assignment = useAgentProfileAssignment({
		agentKind,
		isChatTarget,
		scriptId,
		chatId,
		assignedProfileId,
		selected,
		profiles,
		// Always true while mounted — see the header comment: the label
		// needs the (chat, kind) read at rest, not only while open.
		isOpen: true,
		t,
		onAssigned: () => setChosenId(null),
		onFailed: () => {
			committedRef.current = null;
			setChosenId(null);
		},
	});
	const effectiveId = isChatTarget ? assignment.chatEffectiveProfileId : assignment.activeProfileId;

	// The commit edge: guards + writes live in the hook (`assignHere` /
	// `assign` no-op when the choice is already active).
	useEffect(() => {
		if (chosenId === null || chosenId === committedRef.current) return;
		if (!profiles.some((p) => p.id === chosenId)) return;
		committedRef.current = chosenId;
		if (isChatTarget) assignment.assignHere();
		else assignment.assign();
	}, [chosenId, profiles, isChatTarget, assignment]);

	// Mockup §2: no chip on the kind's first built-in (the seed — its id is
	// the sentinel), and none until the list has loaded (an unloaded list
	// resolves every id to the seed anyway, but the name lookup must not
	// render an empty pill mid-load).
	const effectiveName = profiles.find((p) => p.id === effectiveId)?.name;
	if (effectiveId === BUILTIN_PROFILE_ID || effectiveName === undefined) return null;

	return (
		<Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid="agent-profile-chip"
					aria-label={t("agent_settings_profile")}
					className={cn(
						"flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-accent-dim px-2.5 py-0.5",
						"font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-accent-t whitespace-nowrap",
						"transition-[filter] duration-100 hover:brightness-110",
					)}
				>
					<span className="whitespace-nowrap">{effectiveName}</span>
					<Icons.Caret direction={menuOpen ? "u" : "d"} className="h-3 w-3 shrink-0" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="glass-blur z-[301] flex w-[240px] flex-col overflow-hidden rounded-lg border border-border bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none"
				>
					<div className="flex max-h-[280px] flex-col overflow-y-auto p-1">
						{profiles.map((p) => {
							const isActive = p.id === effectiveId;
							// Mockup §2 row: [check?] name… tag. The effective row is a
							// selection indicator, not a switch target (the switcher's
							// active-row rule — non-interactive, accent-tinted).
							const row = (
								<>
									{isActive && <Icons.Check className="h-3.5 w-3.5 shrink-0" />}
									<span className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)]">
										{p.name}
									</span>
									<MasterListTag>
										{p.isBuiltIn ? t("agent_profile_chip_tag_builtin") : t("agent_profile_chip_tag_own")}
									</MasterListTag>
								</>
							);
							return isActive ? (
								<div
									key={p.id}
									data-testid={`agent-profile-menu-row-${p.id}`}
									data-active="true"
									className="flex items-center gap-1.5 rounded-md bg-accent-dim px-2.5 py-1.5 text-accent-t"
								>
									{row}
								</div>
							) : (
								<button
									key={p.id}
									type="button"
									data-testid={`agent-profile-menu-row-${p.id}`}
									data-active="false"
									onClick={() => {
										setChosenId(p.id);
										setMenuOpen(false);
									}}
									className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-t2 transition-colors hover:bg-s2 hover:text-t1"
								>
									{row}
								</button>
							);
						})}
					</div>
					<button
						type="button"
						data-testid="agent-profile-menu-edit"
						onClick={() => {
							setMenuOpen(false);
							onOpenProfiles();
						}}
						className="flex shrink-0 cursor-pointer items-center gap-1.5 border-t border-border px-2.5 py-2 text-left font-ui text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
					>
						<span className="flex-1">{t("agent_settings_edit_profiles")}</span>
						<Icons.Caret direction="r" className="h-3 w-3 shrink-0 text-t3" />
					</button>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
