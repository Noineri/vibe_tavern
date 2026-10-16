import { useEffect, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../MasterDetailModal.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { EmptyState } from "../empty-state.js";
import { AutoTextarea } from "../auto-textarea.js";
import { Icons } from "../icons.js";
import { TextInput } from "../text-input.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { setCopilotProfile } from "../../../api/copilot-profile-api.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import type { CopilotProfile, CopilotProfileCreate } from "@vibe-tavern/api-contracts";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { AgentSkillModal } from "./AgentSkillModal.js";

/** The read-only built-in seed profile id (EXPERIENCE_COPILOT_PROFILES_PLAN). */
const BUILTIN_PROFILE_ID = "builtin";

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
 * Copilot profile manager (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-9).
 * Mirrors `CoauthorModuleModal` MINUS description/openingMessage/skills: profile
 * list (built-in seed shown read-only, user profiles), name + inline system
 * prompt (AutoTextarea), tool toggles (the keys come from the agent host descriptor).
 * Skills are UNGATED (PM-8, owner ruling 2026-10-12): the model sees every
 * scanned skill regardless of profile, so there are no per-profile skill
 * toggles — the "Manage skills" header button opens `CopilotSkillModal` for the
 * import/delete library instead. "Duplicate built-in" pre-fills a new user
 * profile. Assignment writes `scripts.copilotProfileId` via `setCopilotProfile`
 * (built-in → null = unassign).
 *
 * CONTROLLED — open/close are props (owned by `ExperienceCopilotShell`), not
 * the global `modal-store` (which is co-author-specific).
 */
export interface AgentProfileModalProps {
	scriptId: string;
	/** The agent kind whose profiles this instance manages (AS-8b) — drives
	 *  the kind-filtered list and, through the registered host descriptor, the
	 *  toggleable-tool key set. */
	agentKind: AgentKind;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	isOpen: boolean;
	onClose: () => void;
}

export function AgentProfileModal({ scriptId, agentKind, assignedProfileId, isOpen, onClose }: AgentProfileModalProps) {
	const { t } = useT();
	const toolKeys = getAgentHost(agentKind).toolKeys;

	// Mirror the resolver's null→builtin fallback so the active row is highlighted
	// even when nothing has been explicitly assigned yet.
	const activeProfileId = assignedProfileId ?? BUILTIN_PROFILE_ID;

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
	const [skillManagerOpen, setSkillManagerOpen] = useState(false);

	useEffect(() => {
		if (isOpen) {
			void loadProfiles(agentKind);
		}
		if (!isOpen) {
			setDetailMode("view");
			setDirty(false);
			setConfirmDeleteId(null);
			setConfirmDiscardOpen(false);
			setSkillManagerOpen(false);
		}
	}, [isOpen, loadProfiles]);

	const selected = profiles.find((p) => p.id === selectedId) ?? null;
	const isSelectedActive = selected !== null && selected.id === activeProfileId;

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

	const handleAssign = async () => {
		if (!selected || isSelectedActive) return;
		try {
			// Built-in = unassign (null); a user profile = its id.
			await setCopilotProfile(scriptId, selected.id === BUILTIN_PROFILE_ID ? null : selected.id);
			onClose();
		} catch {
			toast.error(t("copilot_profile_assign_failed"));
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
			<AgentSkillModal isOpen={skillManagerOpen} onClose={() => setSkillManagerOpen(false)} />
			<MasterDetailModal
				isOpen={isOpen}
				onClose={close}
				title={t("copilot_profile_title")}
				subtitle={t("copilot_profile_subtitle")}
				dirty={dirty}
				headerActions={
					<button
						type="button"
						data-testid="copilot-profile-manage-skills-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1"
						onClick={() => setSkillManagerOpen(true)}
					>
						<Icons.Book className="h-3.5 w-3.5" />
						{t("copilot_profile_manage_skills")}
					</button>
				}
				masterClassName="flex w-[260px] shrink-0 flex-col border-r border-border"
				masterContent={({ openDetail }) => (
					<ProfileList
						profiles={profiles}
						isLoading={isLoading}
						selectedId={selectedId}
						activeProfileId={activeProfileId}
						detailMode={detailMode}
						t={t}
						onSelect={(id) => handleSelect(id, openDetail)}
						onAdd={() => handleNew(openDetail)}
						onEdit={(p) => handleEdit(p, openDetail)}
						onDelete={(id) => setConfirmDeleteId(id)}
					/>
				)}
				detailContent={({ closeDetail }) =>
					isEditing ? (
						<ProfileEditor
							draft={draft}
							t={t}
							toolKeys={toolKeys}
							onUpdate={updateDraft}
							onToggleTool={toggleTool}
						/>
					) : selected ? (
						<ProfileView
							profile={selected}
							toolKeys={toolKeys}
							t={t}
							isSelectedActive={isSelectedActive}
							onEdit={() => handleEdit(selected)}
							onDuplicate={() => handleDuplicate(selected)}
							onDelete={() => setConfirmDeleteId(selected.id)}
							closeDetail={closeDetail}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{t("copilot_profile_empty")}</div>
					)
				}
				footer={
					<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3">
						{isEditing ? (
							<>
								<button
									type="button"
									data-testid="copilot-profile-cancel-btn"
									className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1"
									onClick={() => { setDetailMode("view"); setDirty(false); }}
								>
									{t("copilot_profile_cancel")}
								</button>
								<button
									type="button"
									data-testid="copilot-profile-save-btn"
									className="cursor-pointer rounded-md bg-accent px-4 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98]"
									onClick={() => { void handleSave(); }}
								>
									{t("copilot_profile_save")}
								</button>
							</>
						) : (
							<button
								type="button"
								data-testid="copilot-profile-assign-btn"
								disabled={!selected || isSelectedActive}
								className={cn(
									"flex items-center gap-1.5 rounded-md px-4 py-1.5 font-ui text-[0.8rem] font-semibold transition-all",
									isSelectedActive
										? "cursor-default bg-success text-on-accent"
										: "cursor-pointer bg-accent text-on-accent hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-accent",
								)}
								onClick={() => { void handleAssign(); }}
							>
								{isSelectedActive && <Icons.Check className="h-3.5 w-3.5" />}
								{isSelectedActive ? t("copilot_profile_active") : t("copilot_profile_assign")}
							</button>
						)}
					</div>
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
	activeProfileId: string;
	detailMode: DetailMode;
	t: TFunc;
	onSelect: (id: string) => void;
	onAdd: () => void;
	onEdit: (p: CopilotProfile) => void;
	onDelete: (id: string) => void;
}

function ProfileList({ profiles, isLoading, selectedId, activeProfileId, detailMode, t, onSelect, onAdd, onEdit, onDelete }: ProfileListProps) {
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
						return (
							<div
								key={p.id}
								data-testid={`copilot-profile-row-${p.id}`}
								onPointerDown={() => onSelect(p.id)}
								className={cn(
									"group flex cursor-pointer items-center gap-3 border-l-2 min-h-[56px] pl-4 pr-2 touch-manipulation sm:transition-colors",
									isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
								)}
							>
								<span
									className={cn(
										"h-[6px] w-[6px] shrink-0 rounded-full sm:transition-colors",
										isActive ? "bg-accent" : "bg-transparent",
									)}
								/>
								<div className="min-w-0 flex-1 py-2">
									<div className="flex min-w-0 items-center gap-1.5">
										<span className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isSelected ? "text-accent-t" : "text-t2")}>
											{isActive ? "★ " : ""}{p.name}
										</span>
										{p.isBuiltIn && (
											<span className="shrink-0 rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">
												{t("copilot_profile_built_in")}
											</span>
										)}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px] text-t4">{p.id}</div>
								</div>
								{!p.isBuiltIn && (
									<div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											data-testid={`copilot-profile-edit-btn-${p.id}`}
											className="flex h-6 w-6 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1 md:opacity-0 md:group-hover:opacity-100"
											title={t("copilot_profile_edit")}
											onClick={() => onEdit(p)}
										>
											<Icons.Edit className="h-3 w-3" />
										</button>
										<button
											type="button"
											data-testid={`copilot-profile-delete-btn-${p.id}`}
											className="flex h-6 w-6 items-center justify-center rounded text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text md:opacity-0 md:group-hover:opacity-100"
											title={t("copilot_profile_delete")}
											onClick={() => onDelete(p.id)}
										>
											<Icons.Trash className="h-3 w-3" />
										</button>
									</div>
								)}
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
	/** The host-owned toggleable tool keys of the modal's agent kind. */
	toolKeys: readonly string[];
	t: TFunc;
	isSelectedActive: boolean;
	onEdit: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	closeDetail?: () => void;
}

function ProfileView({ profile, toolKeys, t, onEdit, onDuplicate, onDelete }: ProfileViewProps) {
	// AS-7/AS-8b: the wire tool set is a per-kind union; the read widens to a
	// boolean record and projects through the host's keys for this kind (the
	// script kind's toggles differ from the experience ones).
	const toolSetRecord = profile.toolSet as Record<string, boolean | undefined>;
	const enabledTools = toolKeys.filter((key) => toolSetRecord[key] === true);
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{profile.name}</h3>
					{profile.isBuiltIn ? (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("copilot_profile_built_in")}</span>
					) : (
						<span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("copilot_profile_user")}</span>
					)}
				</div>
			</div>

			{profile.isBuiltIn ? (
				<div className="flex gap-2">
					<button
						type="button"
						data-testid="copilot-profile-view-duplicate-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1"
						onClick={onDuplicate}
					>
						<Icons.Copy className="h-3 w-3" />
						{t("copilot_profile_duplicate")}
					</button>
				</div>
			) : (
				<div className="flex gap-2">
					<button
						type="button"
						data-testid="copilot-profile-view-edit-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1"
						onClick={onEdit}
					>
						<Icons.Edit className="h-3 w-3" />
						{t("copilot_profile_edit")}
					</button>
					<button
						type="button"
						data-testid="copilot-profile-view-delete-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t3 transition-colors hover:border-danger hover:text-danger-text"
						onClick={onDelete}
					>
						<Icons.Trash className="h-3 w-3" />
						{t("copilot_profile_delete")}
					</button>
				</div>
			)}

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("copilot_profile_base_prompt")}>
					<pre className="whitespace-pre-wrap break-words rounded bg-s2 p-2 font-mono text-[11px] leading-relaxed text-t2">{profile.basePrompt}</pre>
				</PreviewRow>

				<PreviewRow label={t("copilot_profile_tools")}>
					{enabledTools.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{enabledTools.map((key) => (
								<span key={key} className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-t2">{key}</span>
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
	/** The kind's toggleable-tool keys (AS-8b — kind-aware). */
	toolKeys: readonly string[];
	onUpdate: <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;
	onToggleTool: (key: string) => void;
}

function ProfileEditor({ draft, t, toolKeys, onUpdate, onToggleTool }: ProfileEditorProps) {
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
								{key}
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
