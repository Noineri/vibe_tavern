// fork #1 of CoauthorModuleModal (apps/web/src/components/coauthor/CoauthorModuleModal.tsx):
// the profile modal frame-clones the module modal (MasterDetail shell, row /
// detail rules, MasterDetailFooter matrix) while its data flow stays
// profile-specific (name + basePrompt + toolSet, no description / skills /
// max steps). Frame correspondence: list rows (name line 1 + tags + one
// active marker, no id line, no hover icons) → detail (title + tag, clamped
// prompt preview + toggle, labelled tool chips) → footer (left actions,
// right Close + primary / quiet state, edit Cancel + Save).
import { useEffect, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown, MasterDetailFooter, type MasterDetailParentBack } from "../MasterDetailModal.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { EmptyState } from "../empty-state.js";
import { AutoTextarea } from "../auto-textarea.js";
import { Icons } from "../icons.js";
import { TextInput } from "../text-input.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import type { CopilotProfile, CopilotProfileCreate } from "@vibe-tavern/api-contracts";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { AgentChatProfileFooter } from "./agent-profile-chat-footer.js";
import { resolveAgentProfileToolLabel } from "./agent-tool-labels.js";
import { BUILTIN_PROFILE_ID, useAgentProfileAssignment } from "./use-agent-profile-assignment.js";

/** Copilot profile draft — leaner than a co-author module (no description,
 *  no openingMessage) and, since PM-8 (skills ungated), no skillIds either:
 *  a profile is name + basePrompt + toolSet. The toolSet is a loose boolean
 *  record (AS-8b: which keys are valid depends on the profile's agent kind). */
interface ProfileDraft {
	name: string;
	basePrompt: string;
	toolSet: Record<string, boolean>;
}

const EMPTY_DRAFT: ProfileDraft = {
	name: "",
	basePrompt: "",
	toolSet: {},
};

function profileToDraft(p: CopilotProfile): ProfileDraft {
	return {
		name: p.name,
		basePrompt: p.basePrompt,
		toolSet: { ...p.toolSet },
	};
}

function draftToCreateInput(d: ProfileDraft, agentKind: string): CopilotProfileCreate {
	return {
		name: d.name.trim(),
		basePrompt: d.basePrompt,
		toolSet: d.toolSet,
		agentKind,
	};
}

type DetailMode = "view" | "edit" | "create";

/**
 * Copilot profile manager (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-9;
 * frame-polished in AP-24): profile list (built-in seed shown read-only,
 * user profiles), name + clamped system prompt preview + labelled tool chips
 * in the read-only view, the editor form for create / edit. Skills are
 * UNGATED (PM-8, owner ruling 2026-10-12): the model sees every scanned
 * skill regardless of profile, so there are no per-profile skill toggles —
 * AP-27 moved the import/delete library to the settings summary
 * (`AgentSettingsModal` opens `AgentSkillModal` from its skills row), so
 * this modal keeps no skill surface. "Duplicate" pre-fills a new user profile.
 * Assignment writes `scripts.copilotProfileId` via `setCopilotProfile`
 * (built-in → null = unassign) for script-target hosts; chat-target hosts
 * write the (chat, kind) row + the kind default through
 * `use-agent-profile-assignment.ts` (AP-27 reuses that hook).
 *
 * CONTROLLED — open/close are props (owned by `ExperienceCopilotShell`), not
 * the global `modal-store` (which is co-author-specific).
 */
export interface AgentProfileModalProps {
	/** SC-13a: optional since the chat-owned shell passes only its chatId —
	 *  the script write below is unreachable for chat-target hosts (their
	 *  footer renders the chat actions instead). */
	scriptId?: string;
	/** SC-0g: the chat whose own profile choice a chat-target host writes.
	 *  Required when the host's `profileAssignment` targets `"chat"`
	 *  (no production chat host exists yet — SC-13; tests pass a fixture
	 *  chat id). Ignored by script-target hosts. */
	chatId?: string;
	/** The agent kind whose profiles this instance manages (AS-8b) — drives
	 *  the kind-filtered list and, through the registered host descriptor, the
	 *  toggleable-tool key set. */
	agentKind: AgentKind;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	isOpen: boolean;
	onClose: () => void;
	/** Optional drill-down parent (AP-27): the settings summary passes its
	 *  own title here — absent = standalone, no back link. */
	parentBack?: MasterDetailParentBack;
}

export function AgentProfileModal({ scriptId, chatId, agentKind, assignedProfileId, isOpen, onClose, parentBack }: AgentProfileModalProps) {
	const { t } = useT();
	const host = getAgentHost(agentKind);
	const toolKeys = host.toolKeys;
	// SC-0g: the modal renders its single-action (script) or dual-action
	// (chat) variant purely from the host descriptor — no kind literal here.
	const isChatTarget = host.profileAssignment.target === "chat";

	const profiles = useCopilotProfileStore((s) => s.profiles);
	const isLoading = useCopilotProfileStore((s) => s.isLoading);
	const loadProfiles = useCopilotProfileStore((s) => s.load);
	const createProfile = useCopilotProfileStore((s) => s.create);
	const updateProfile = useCopilotProfileStore((s) => s.update);
	const removeProfile = useCopilotProfileStore((s) => s.remove);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailMode, setDetailMode] = useState<DetailMode>("view");
	const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
	const [dirty, setDirty] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

	const selected = profiles.find((p) => p.id === selectedId) ?? null;

	// AP-24: the assignment logic (which target, default-vs-thread
	// resolution) lives in `use-agent-profile-assignment.ts` — AP-27 reuses
	// it. Behavior is unchanged; only the location moved.
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
		onAssigned: onClose,
	});

	useEffect(() => {
		if (isOpen) {
			void loadProfiles(agentKind);
		}
		if (!isOpen) {
			setDetailMode("view");
			setDirty(false);
			setConfirmDeleteId(null);
			setConfirmDiscardOpen(false);
		}
	}, [isOpen, loadProfiles, agentKind]);

	const handleSelect = (id: string, openDetail?: () => void) => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setSelectedId(id);
		setDetailMode("view");
		openDetail?.();
	};

	const handleNew = (openDetail?: () => void) => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setDraft(EMPTY_DRAFT);
		setDetailMode("create");
		setSelectedId(null);
		openDetail?.();
	};

	const handleEdit = (profile: CopilotProfile, openDetail?: () => void) => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setDraft(profileToDraft(profile));
		setSelectedId(profile.id);
		setDetailMode("edit");
		openDetail?.();
	};

	/** Duplicate the built-in (read-only) seed into an editable user copy. The
	 *  draft is seeded from the RESOLVED fields — basePrompt is the inline text
	 *  the API already materialized for the seed. Later seed changes never
	 *  mutate the copy. */
	const handleDuplicate = (profile: CopilotProfile, openDetail?: () => void) => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setDraft({ ...profileToDraft(profile), name: profile.name + t("copilot_profile_duplicate_suffix") });
		setDetailMode("create");
		setSelectedId(null);
		openDetail?.();
	};

	const updateDraft = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setDirty(true);
	};

	const toggleTool = (key: string) => {
		setDraft((prev) => ({
			...prev,
			toolSet: { ...prev.toolSet, [key]: !prev.toolSet[key] },
		}));
		setDirty(true);
	};

	const handleSave = async () => {
		if (!draft.name.trim()) {
			toast.error(t("copilot_profile_name_required"));
			return;
		}
		if (!draft.basePrompt.trim()) {
			toast.error(t("copilot_profile_base_prompt_required"));
			return;
		}
		const input = draftToCreateInput(draft, agentKind);
		try {
			// The store actions wrap the profile API (create/update) and
			// refresh the list — the modal only drives draft → save → view.
			if (detailMode === "create") {
				const created = await createProfile(input);
				setSelectedId(created.id);
			} else if (detailMode === "edit" && selectedId) {
				await updateProfile(selectedId, input);
			}
			setDetailMode("view");
			setDirty(false);
		} catch {
			toast.error(t(detailMode === "create" ? "copilot_profile_create_failed" : "copilot_profile_update_failed"));
		}
	};

	const handleConfirmDelete = async () => {
		const id = confirmDeleteId;
		setConfirmDeleteId(null);
		if (!id) return;
		try {
			await removeProfile(id);
			if (selectedId === id) {
				setSelectedId(BUILTIN_PROFILE_ID);
				setDetailMode("view");
			}
		} catch {
			toast.error(t("copilot_profile_delete_failed"));
		}
	};

	const close = () => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		onClose();
	};

	const isEditing = detailMode === "edit" || detailMode === "create";

	return (
		<>
			{confirmDiscardOpen && (
				<DestructiveConfirmModal
					title={t("copilot_profile_unsaved_changes")}
					body={<>{t("copilot_profile_unsaved_changes")}</>}
					confirmLabel={t("copilot_profile_discard")}
					onConfirm={() => {
						setDirty(false);
						setDetailMode("view");
						setConfirmDiscardOpen(false);
					}}
					onCancel={() => setConfirmDiscardOpen(false)}
				/>
			)}
			{confirmDeleteId && (
				<DestructiveConfirmModal
					title={t("copilot_profile_delete_confirm_title")}
					body={<>{t("copilot_profile_delete_confirm_body")}</>}
					confirmLabel={t("copilot_profile_delete")}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setConfirmDeleteId(null)}
				/>
			)}
			<MasterDetailModal
				isOpen={isOpen}
				onClose={close}
				title={t("copilot_profile_title")}
				subtitle={t("copilot_profile_subtitle")}
				dirty={dirty}
				parentBack={parentBack}
				masterClassName="flex w-[260px] shrink-0 flex-col border-r border-border"
				masterContent={({ openDetail }) => (
					<ProfileList
						profiles={profiles}
						isLoading={isLoading}
						selectedId={selectedId}
						activeProfileId={isChatTarget ? assignment.chatEffectiveProfileId : assignment.activeProfileId}
						// SC-0g: chat-target hosts mark the kind-default row (a
						// second authored pill, same canon shape as built-in).
						// Script hosts leave defaultProfileId undefined —
						// no badge, rows byte-identical to before.
						defaultProfileId={assignment.defaultProfileId}
						detailMode={detailMode}
						t={t}
						onSelect={(id) => handleSelect(id, openDetail)}
						onAdd={() => handleNew(openDetail)}
					/>
				)}
				detailContent={({ closeDetail }) =>
					isEditing ? (
						<ProfileEditor
							draft={draft}
							t={t}
							agentKind={agentKind}
							toolKeys={toolKeys}
							onUpdate={updateDraft}
							onToggleTool={toggleTool}
						/>
					) : selected ? (
						<ProfileView
							profile={selected}
							t={t}
							closeDetail={closeDetail}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{t("copilot_profile_empty")}</div>
					)
				}
				footer={
					isEditing ? (
						// Edit mode: right side «Отмена» / «Сохранить» only.
						<MasterDetailFooter
							right={
								<>
									<button
										type="button"
										data-testid="copilot-profile-cancel-btn"
										className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
										onClick={() => { setDetailMode("view"); setDirty(false); }}
									>
										{t("copilot_profile_cancel")}
									</button>
									<button
										type="button"
										data-testid="copilot-profile-save-btn"
										className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
										onClick={() => { void handleSave(); }}
									>
										{t("copilot_profile_save")}
									</button>
								</>
							}
						/>
					) : (
						<MasterDetailFooter
							actions={
								selected
									? selected.isBuiltIn
										? [
											{
												icon: <Icons.Copy className="h-3.5 w-3.5" />,
												label: t("copilot_profile_duplicate"),
												onClick: () => handleDuplicate(selected),
											},
										]
										: [
											{
												icon: <Icons.Copy className="h-3.5 w-3.5" />,
												label: t("copilot_profile_duplicate"),
												onClick: () => handleDuplicate(selected),
											},
											{
												icon: <Icons.Edit className="h-3.5 w-3.5" />,
												label: t("copilot_profile_edit"),
												onClick: () => handleEdit(selected),
											},
											{
												icon: <Icons.Trash className="h-3.5 w-3.5" />,
												label: t("copilot_profile_delete"),
												onClick: () => setConfirmDeleteId(selected.id),
												destructive: true,
											},
										]
									: []
							}
							onClose={close}
							right={
								isChatTarget ? (
									// SC-0k: secondary default first, primary here
									// last (the edit footer's Cancel → Save order).
									<AgentChatProfileFooter
										hasSelection={selected !== null}
										isSelectedHere={assignment.isSelectedHere}
										isSelectedDefault={assignment.isSelectedDefault}
										t={t}
										onAssignHere={assignment.assignHere}
										onAssignDefault={assignment.assignDefault}
									/>
								) : selected && assignment.isSelectedActive ? (
									// The running profile: a quiet state label,
									// not a second primary action.
									<span
										data-testid="copilot-profile-in-use-state"
										className="flex cursor-default items-center gap-1.5 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
									>
										<Icons.Check className="h-3.5 w-3.5" />
										{t("copilot_profile_in_use_label")}
									</span>
								) : (
									<button
										type="button"
										data-testid="copilot-profile-assign-btn"
										disabled={!selected}
										className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
										onClick={assignment.assign}
									>
										{t("copilot_profile_assign")}
									</button>
								)
							}
						/>
					)
				}
			/>
		</>
	);
}

// ─── Master list ────────────────────────────────────────────────────────

interface ProfileListProps {
	profiles: CopilotProfile[];
	isLoading: boolean;
	selectedId: string | null;
	// SC-0k: the EFFECTIVE profile id for chat-target hosts (the chat's own
	// choice when it resolves, else the kind default when it resolves, else
	// the built-in — the modal-side mirror of the server chain, never null
	// for a loaded list); the script path passes the assignment mirror.
	activeProfileId: string | null;
	// SC-0g: the kind-default profile id — undefined = script host (no badge).
	// A chat-target host passes the raw kind default (possibly null); null
	// marks the built-in seed, mirroring the script null→builtin fallback.
	defaultProfileId?: string | null;
	detailMode: DetailMode;
	t: TFunc;
	onSelect: (id: string) => void;
	onAdd: () => void;
}

function ProfileList({ profiles, isLoading, selectedId, activeProfileId, defaultProfileId, detailMode, t, onSelect, onAdd }: ProfileListProps) {
	if (isLoading) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t("copilot_profile_loading")}</div>;
	}
	return (
		<div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
			<div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
				{t("copilot_profile_list_label")}
			</div>
			<div className="flex-1 overflow-y-auto">
				{profiles.length === 0 ? (
					<div className="flex h-full items-center justify-center px-2">
						<EmptyState
							icon={<Icons.Tool />}
							title={t("copilot_profile_empty")}
							sub={t("copilot_profile_empty_sub")}
						/>
					</div>
				) : (
					profiles.map((p) => {
						const isActive = p.id === activeProfileId;
						const isSelected = (p.id === selectedId && detailMode === "view") || (detailMode === "edit" && p.id === selectedId);
						// The kind-default pill (chat-target hosts only): the
						// null default reads as the built-in seed, mirroring
						// the script null→builtin fallback.
						const showDefaultPill = defaultProfileId !== undefined && p.id === (defaultProfileId ?? BUILTIN_PROFILE_ID);
						return (
							<div
								key={p.id}
								data-testid={`copilot-profile-row-${p.id}`}
								onPointerDown={() => onSelect(p.id)}
								className={cn(
									"cursor-pointer border-l-2 min-h-[56px] pl-4 pr-2 touch-manipulation sm:transition-colors",
									isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
								)}
							>
								<div className="min-w-0 py-2">
									{/* SC-16d: the name owns line 1 alone (wraps,
									// never cut); the marker + pills own the lines
									// below (only when present); no id line. */}
									<div className="flex min-w-0 items-center gap-1.5">
										<span
											data-testid={`copilot-profile-row-name-${p.id}`}
											className={cn("whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isSelected ? "text-accent-t" : "text-t2")}
										>
											{p.name}
										</span>
									</div>
									{(p.isBuiltIn || showDefaultPill) && (
										<div data-testid={`copilot-profile-row-pills-${p.id}`} className="mt-1 flex flex-wrap gap-1">
											{p.isBuiltIn && (
												<span className="shrink-0 rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
													{t("copilot_profile_built_in")}
												</span>
											)}
											{showDefaultPill && (
												<span className="shrink-0 rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
													{t("copilot_profile_default")}
												</span>
											)}
										</div>
									)}
									{isActive && (
										<div className="mt-0.5 flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t4">
											<Icons.Check className="h-3 w-3 shrink-0" />
											{t("copilot_profile_in_use")}
										</div>
									)}
								</div>
								<MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-3" />
							</div>
						);
					})
				)}
			</div>
			<div className="shrink-0 border-t border-border px-3 pt-3">
				<button
					type="button"
					data-testid="copilot-profile-new-btn"
					className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
					onClick={() => onAdd()}
				>
					<Icons.Plus /> {t("copilot_profile_new")}
				</button>
			</div>
		</div>
	);
}

// ─── Read-only view (built-in + user profiles) ─────────────────────────

interface ProfileViewProps {
	profile: CopilotProfile;
	t: TFunc;
	closeDetail?: () => void;
}

/** Bodies longer than this get the clamped preview + toggle (the AP-23
 *  skill-library precedent: `BODY_CLAMP_AT` there); shorter bodies render
 *  whole with no toggle. A character count stands in for the rendered
 *  8-line clamp — deterministic and test-pinnable. */
const PROMPT_CLAMP_AT = 500;

function ProfileView({ profile, t }: ProfileViewProps) {
	// AS-7/AS-8b: the wire tool set is a per-kind union; the read widens to a
	// boolean record and projects through the host's keys for the profile's
	// own kind (the script kind's toggles differ from the experience ones).
	// Labels come from the per-kind exhaustive map (`agent-tool-labels.ts`).
	const toolSetRecord = profile.toolSet as Record<string, boolean | undefined>;
	const enabledTools = Object.keys(toolSetRecord).filter((key) => toolSetRecord[key] === true);
	const [promptExpanded, setPromptExpanded] = useState(false);
	useEffect(() => {
		setPromptExpanded(false);
	}, [profile.id]);
	const isLongPrompt = profile.basePrompt.length > PROMPT_CLAMP_AT;
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h3 data-testid="copilot-profile-detail-name" className="font-body text-[17px] font-semibold text-t1">{profile.name}</h3>
					<span data-testid="copilot-profile-detail-tag" className="rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
						{profile.isBuiltIn ? t("copilot_profile_built_in") : t("copilot_profile_custom_tag")}
					</span>
				</div>
			</div>

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("copilot_profile_base_prompt")}>
					<pre
						data-testid="copilot-profile-prompt-preview"
						className={cn(
							"whitespace-pre-wrap break-words rounded bg-s2 p-2 font-mono text-[11px] leading-relaxed text-t2",
							!promptExpanded && isLongPrompt && "line-clamp-8",
						)}
					>
						{profile.basePrompt}
					</pre>
					{isLongPrompt && (
						<button
							type="button"
							data-testid="copilot-profile-prompt-toggle"
							className="mt-1.5 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent transition-colors hover:text-accent-t"
							onClick={() => setPromptExpanded((v) => !v)}
						>
							{promptExpanded ? t("copilot_skill_collapse") : t("copilot_skill_show_full")}
						</button>
					)}
				</PreviewRow>

				<PreviewRow label={t("copilot_profile_tools")}>
					{enabledTools.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{enabledTools.map((key) => (
								<span key={key} className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-t2">{resolveAgentProfileToolLabel(t, profile.agentKind, key)}</span>
							))}
						</div>
					) : (
						<span className="font-ui text-[12px] text-t3">{t("copilot_profile_no_skills")}</span>
					)}
				</PreviewRow>
			</dl>
		</div>
	);
}

// ─── Editor form (create + edit) ────────────────────────────────────────

interface ProfileEditorProps {
	draft: ProfileDraft;
	t: TFunc;
	/** The kind under edit — selects the per-kind tool-label map (AS-8b). */
	agentKind: string;
	/** The kind's toggleable-tool keys (AS-8b — kind-aware). */
	toolKeys: readonly string[];
	onUpdate: <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;
	onToggleTool: (key: string) => void;
}

function ProfileEditor({ draft, t, agentKind, toolKeys, onUpdate, onToggleTool }: ProfileEditorProps) {
	return (
		<div className="flex flex-col gap-4" data-testid="copilot-profile-editor">
			<div className="flex flex-col">
				<label className={lblCls}>{t("copilot_profile_name_label")}</label>
				<TextInput
					data-testid="copilot-profile-name-input"
					placeholder={t("copilot_profile_name_placeholder")}
					value={draft.name}
					onChange={(e) => onUpdate("name", e.target.value)}
				/>
			</div>

			<div className="flex flex-col">
				<label className={lblCls}>{t("copilot_profile_base_prompt")}</label>
				<AutoTextarea
					mono
					minRows={6}
					value={draft.basePrompt}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate("basePrompt", e.target.value)}
				/>
				<p className="font-ui text-[10px] leading-relaxed text-t3">{t("copilot_profile_base_prompt_hint")}</p>
			</div>

			<Field label={t("copilot_profile_tools")}>
				<div className="flex flex-wrap gap-1.5">
					{toolKeys.map((key) => {
						const active = draft.toolSet[key] === true;
						return (
							<button
								key={key}
								type="button"
								className={cn(
									"cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
									active ? "border-accent bg-accent-dim text-accent-t" : "border-border text-t3 hover:text-t1",
								)}
								onClick={() => onToggleTool(key)}
							>
								{resolveAgentProfileToolLabel(t, agentKind, key)}
							</button>
						);
					})}
				</div>
			</Field>
		</div>
	);
}

// ─── Shared field primitives ─────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<label className="font-ui text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</label>
			{children}
			{hint && <p className="font-ui text-[10px] leading-relaxed text-t3">{hint}</p>}
		</div>
	);
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-ui text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}
