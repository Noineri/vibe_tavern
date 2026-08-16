import { useEffect, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../../../shared/MasterDetailModal.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { Icons } from "../../../shared/icons.js";
import { inputCls, monoCls, lblCls } from "../../fields/field-styles.js";
import { useCopilotProfileStore } from "../../../../stores/copilot-profile-store.js";
import { useCopilotSkillStore } from "../../../../stores/copilot-skill-store.js";
import { setCopilotProfile } from "../../../../api/copilot-profile-api.js";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../../../lib/cn.js";
import { type CopilotProfile, type CopilotProfileCreate, type CopilotToolSet, type SkillCatalogEntryDto, COPILOT_TOOL_KEYS, COPILOT_MAX_STEPS_MIN, COPILOT_MAX_STEPS_MAX, COPILOT_MAX_STEPS_DEFAULT } from "@vibe-tavern/api-contracts";
import { CopilotSkillModal } from "./CopilotSkillModal.js";

/** The read-only built-in seed profile id (EXPERIENCE_COPILOT_PROFILES_PLAN). */
const BUILTIN_PROFILE_ID = "builtin";

/** Copilot profile draft — leaner than a co-author module (no description,
 *  no openingMessage). */
interface ProfileDraft {
	name: string;
	basePrompt: string;
	skillIds: string[];
	toolSet: CopilotToolSet;
	maxSteps: number;
}

const EMPTY_DRAFT: ProfileDraft = {
	name: "",
	basePrompt: "",
	skillIds: [],
	toolSet: {},
	maxSteps: COPILOT_MAX_STEPS_DEFAULT,
};

function profileToDraft(p: CopilotProfile): ProfileDraft {
	return {
		name: p.name,
		basePrompt: p.basePrompt,
		skillIds: [...p.skillIds],
		toolSet: { ...p.toolSet },
		maxSteps: p.maxSteps,
	};
}

function draftToCreateInput(d: ProfileDraft): CopilotProfileCreate {
	return {
		name: d.name.trim(),
		basePrompt: d.basePrompt,
		skillIds: d.skillIds,
		toolSet: d.toolSet,
		maxSteps: d.maxSteps,
	};
}

type DetailMode = "view" | "edit" | "create";

/**
 * Copilot profile manager (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-9).
 * Mirrors `CoauthorModuleModal` MINUS description/openingMessage: profile list
 * (built-in seed shown read-only, user profiles), name + inline system prompt
 * (AutoTextarea), catalog-driven skill toggles, tool checkboxes (the 5 keys
 * from `COPILOT_TOOL_KEYS`), and a maxSteps number input. "Duplicate built-in"
 * pre-fills a new user profile. Assignment writes `scripts.copilotProfileId`
 * via `setCopilotProfile` (built-in → null = unassign).
 *
 * CONTROLLED — open/close are props (owned by `ExperienceCopilotShell`), not
 * the global `modal-store` (which is co-author-specific).
 */
export interface CopilotProfileModalProps {
	scriptId: string;
	/** The profile currently assigned to this experience, or null (built-in seed). */
	assignedProfileId: string | null;
	isOpen: boolean;
	onClose: () => void;
}

export function CopilotProfileModal({ scriptId, assignedProfileId, isOpen, onClose }: CopilotProfileModalProps) {
	const { t } = useT();

	// Mirror the resolver's null→builtin fallback so the active row is highlighted
	// even when nothing has been explicitly assigned yet.
	const activeProfileId = assignedProfileId ?? BUILTIN_PROFILE_ID;

	const profiles = useCopilotProfileStore((s) => s.profiles);
	const isLoading = useCopilotProfileStore((s) => s.isLoading);
	const loadProfiles = useCopilotProfileStore((s) => s.load);
	const createProfile = useCopilotProfileStore((s) => s.create);
	const updateProfile = useCopilotProfileStore((s) => s.update);
	const removeProfile = useCopilotProfileStore((s) => s.remove);

	const skillEntries = useCopilotSkillStore((s) => s.entries);
	const loadSkills = useCopilotSkillStore((s) => s.load);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailMode, setDetailMode] = useState<DetailMode>("view");
	const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
	const [dirty, setDirty] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
	const [skillManagerOpen, setSkillManagerOpen] = useState(false);

	useEffect(() => {
		if (isOpen) {
			void loadProfiles();
			void loadSkills();
		}
		if (!isOpen) {
			setDetailMode("view");
			setDirty(false);
			setConfirmDeleteId(null);
			setConfirmDiscardOpen(false);
			setSkillManagerOpen(false);
		}
	}, [isOpen, loadProfiles, loadSkills]);

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

	const toggleSkill = (skillId: string) => {
		setDraft((prev) => {
			const has = prev.skillIds.includes(skillId);
			return {
				...prev,
				skillIds: has ? prev.skillIds.filter((s) => s !== skillId) : [...prev.skillIds, skillId],
			};
		});
		setDirty(true);
	};

	const toggleTool = (key: keyof CopilotToolSet) => {
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
		const input = draftToCreateInput(draft);
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
			<CopilotSkillModal isOpen={skillManagerOpen} onClose={() => setSkillManagerOpen(false)} />
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
				containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[760px] w-[1040px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
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
							skills={skillEntries}
							t={t}
							onUpdate={updateDraft}
							onToggleSkill={toggleSkill}
							onToggleTool={toggleTool}
						/>
					) : selected ? (
						<ProfileView
							profile={selected}
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
	t: TFunc;
	isSelectedActive: boolean;
	onEdit: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	closeDetail?: () => void;
}

function ProfileView({ profile, t, onEdit, onDuplicate, onDelete }: ProfileViewProps) {
	const enabledTools = COPILOT_TOOL_KEYS.filter((key) => profile.toolSet[key] === true);
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

				<PreviewRow label={t("copilot_profile_max_steps")}>
					<span className="font-mono text-[13px] text-t1">{profile.maxSteps}</span>
				</PreviewRow>

				<PreviewRow label={t("copilot_profile_skills")}>
					{profile.skillIds.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{profile.skillIds.map((id) => (
								<span key={id} className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-t2">{id}</span>
							))}
						</div>
					) : (
						<span className="font-ui text-[12px] text-t3">{t("copilot_profile_no_skills")}</span>
					)}
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
	/** Merged copilot skill catalog (built-in + user). Drives the skill toggles. */
	skills: SkillCatalogEntryDto[];
	t: TFunc;
	onUpdate: <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;
	onToggleSkill: (skillId: string) => void;
	onToggleTool: (key: keyof CopilotToolSet) => void;
}

function ProfileEditor({ draft, skills, t, onUpdate, onToggleSkill, onToggleTool }: ProfileEditorProps) {
	return (
		<div className="flex flex-col gap-4" data-testid="copilot-profile-editor">
			<div className="flex flex-col gap-1">
				<label className={lblCls}>{t("copilot_profile_name_label")}</label>
				<input
					type="text"
					data-testid="copilot-profile-name-input"
					className={inputCls}
					placeholder={t("copilot_profile_name_placeholder")}
					value={draft.name}
					onChange={(e) => onUpdate("name", e.target.value)}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<label className={lblCls}>{t("copilot_profile_base_prompt")}</label>
				<AutoTextarea
					className={monoCls}
					minRows={6}
					value={draft.basePrompt}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate("basePrompt", e.target.value)}
				/>
				<p className="font-ui text-[10px] leading-relaxed text-t3">{t("copilot_profile_base_prompt_hint")}</p>
			</div>

			<Field label={t("copilot_profile_skills")} hint={t("copilot_profile_skills_hint")}>
				{skills.length === 0 && draft.skillIds.length === 0 ? (
					<span className="font-ui text-[12px] text-t3">{t("copilot_profile_no_skills")}</span>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{skills.map((skill) => {
							const active = draft.skillIds.includes(skill.id);
							return (
								<button
									key={skill.id}
									type="button"
									title={skill.description}
									className={cn(
										"cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
										active ? "border-accent bg-accent-dim text-accent-t" : "border-border text-t3 hover:text-t1",
									)}
									onClick={() => onToggleSkill(skill.id)}
								>
									{skill.name}
								</button>
							);
						})}
						{draft.skillIds
							.filter((id) => !skills.some((s) => s.id === id))
							.map((orphanId) => (
								<button
									key={`orphan:${orphanId}`}
									type="button"
									data-testid={`copilot-profile-skill-orphan-${orphanId}`}
									title={t("copilot_profile_skill_orphan_title")}
									className="cursor-pointer rounded-full border border-dashed border-danger/50 px-2.5 py-0.5 font-mono text-[11px] text-danger-text line-through transition-colors hover:bg-danger-dim"
									onClick={() => onToggleSkill(orphanId)}
								>
									{orphanId}
								</button>
							))}
					</div>
				)}
			</Field>

			<Field label={t("copilot_profile_tools")}>
				<div className="flex flex-wrap gap-1.5">
					{COPILOT_TOOL_KEYS.map((key) => {
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

			<Field label={t("copilot_profile_max_steps")} hint={t("copilot_profile_max_steps_hint")}>
				<input
					type="number"
					min={COPILOT_MAX_STEPS_MIN}
					max={COPILOT_MAX_STEPS_MAX}
					className="w-20 rounded border border-border bg-bg px-2 py-1.5 font-mono text-[13px] text-t1 outline-none focus:border-accent"
					value={draft.maxSteps}
					onChange={(e) => onUpdate("maxSteps", Math.max(COPILOT_MAX_STEPS_MIN, Math.min(COPILOT_MAX_STEPS_MAX, Number(e.target.value) || COPILOT_MAX_STEPS_MIN)))}
				/>
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
