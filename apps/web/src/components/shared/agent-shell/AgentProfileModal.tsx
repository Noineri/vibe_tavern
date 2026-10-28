// fork #1 of CoauthorModuleModal (apps/web/src/components/coauthor/CoauthorModuleModal.tsx):
// the profile modal frame-clones the module modal (MasterDetail shell,
// detail/editor, MasterDetailFooter matrix) while its data flow stays
// profile-specific (name + basePrompt + toolSet, no description / skills /
// max steps). Frame correspondence: detail (title + tag, clamped prompt
// preview + toggle, labelled tool chips) → footer (left actions, right
// Close + primary / quiet state, edit Cancel + Save). The list renders
// through the shared master-list primitive (ML-8) — this fork no longer
// counts the list rows.
import { useEffect, useState } from "react";
import { MasterDetailModal, MasterDetailFooter, type MasterDetailParentBack } from "../MasterDetailModal.js";
import { MasterListTag } from "../master-list/master-list-tag.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { AutoTextarea } from "../auto-textarea.js";
import { Icons } from "../icons.js";
import { TextInput } from "../text-input.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import type { CopilotProfile, CopilotProfileCreate, CopilotProfileUpdate } from "@vibe-tavern/api-contracts";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { AgentChatProfileFooter } from "./agent-profile-chat-footer.js";
import { AgentProfileModelBlock } from "./AgentProfileModelBlock.js";
import { ProfileList, type DetailMode } from "./agent-profile-list.js";
import { resolveAgentProfileToolLabel } from "./agent-tool-labels.js";
import { BUILTIN_PROFILE_ID, useAgentProfileAssignment } from "./use-agent-profile-assignment.js";
import { builtinProfileDisplayName } from "../../../lib/agent-builtin-profiles.js";

/** Copilot profile draft — leaner than a co-author module (no description,
 *  no openingMessage) and, since PM-8 (skills ungated), no skillIds either:
 *  a profile is name + basePrompt + toolSet. The toolSet is a loose boolean
 *  record (AS-8b: which keys are valid depends on the profile's agent kind).
 *  DR-7b adds `sourceBuiltinId` — create-only provenance: duplicating a
 *  BUILT-IN row records that row's id; duplicating a USER row passes its own
 *  source through (a copy of a director copy is still a director copy); a
 *  user row without a source stays undefined. It never rides the edit save
 *  (`draftToUpdateInput` omits it — provenance is immutable after create). */
interface ProfileDraft {
	name: string;
	basePrompt: string;
	toolSet: Record<string, boolean>;
	/** DR-7b: the built-in this copy came from (undefined = no source). */
	sourceBuiltinId?: string;
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
		// DR-7b: provenance rides the draft for the create that follows a
		// duplicate — a built-in row's own id, or a user row's existing source
		// passed through (undefined when it has none).
		sourceBuiltinId: p.isBuiltIn ? p.id : p.sourceBuiltinId ?? undefined,
	};
}

function draftToCreateInput(d: ProfileDraft, agentKind: string): CopilotProfileCreate {
	return {
		name: d.name.trim(),
		basePrompt: d.basePrompt,
		toolSet: d.toolSet,
		agentKind,
		// DR-7b: provenance rides the create only when the draft carries one —
		// a from-scratch create sends NO key (byte-identical to before).
		...(d.sourceBuiltinId !== undefined ? { sourceBuiltinId: d.sourceBuiltinId } : {}),
	};
}

/** The edit-save body: the create shape MINUS `agentKind` — the kind is
 *  immutable (AS-3), and the strict update contract omits the key, so a
 *  PATCH carrying it is rejected with a 422. The server re-validates
 *  toolSet against the stored row's kind. DR-7b: `sourceBuiltinId` is
 *  omitted the same way (provenance is immutable after create — the update
 *  contract strict-rejects the key). */
function draftToUpdateInput(d: ProfileDraft): CopilotProfileUpdate {
	return {
		name: d.name.trim(),
		basePrompt: d.basePrompt,
		toolSet: d.toolSet,
	};
}

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
	/** DR-8 (mockup §11): the pair the composer's pills show right now — the
	 *  starting point when the user engages the own segment on a profile with
	 *  no stored own model yet (they change it before anything is written).
	 *  Absent — the revealed pills start empty. */
	currentModel?: { providerProfileId: string | null; model?: string };
}

export function AgentProfileModal({ scriptId, chatId, agentKind, assignedProfileId, isOpen, onClose, parentBack, currentModel }: AgentProfileModalProps) {
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
	 *  mutate the copy. DR-7b: the draft also records the duplicate's SOURCE
	 *  (`profileToDraft` — the duplicated row's id for a built-in, a user
	 *  row's own source passed through), so the create persists provenance. */
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
		try {
			// The store actions wrap the profile API (create/update) and
			// refresh the list — the modal only drives draft → save → view.
			if (detailMode === "create") {
				const created = await createProfile(draftToCreateInput(draft, agentKind));
				setSelectedId(created.id);
			} else if (detailMode === "edit" && selectedId) {
				await updateProfile(selectedId, draftToUpdateInput(draft));
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
						agentKind={agentKind}
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
							currentModel={currentModel}
							closeDetail={closeDetail}
						/>
					) : (
						<div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("copilot_profile_empty")}</div>
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

// ─── Read-only view (built-in + user profiles) ─────────────────────────

interface ProfileViewProps {
	profile: CopilotProfile;
	t: TFunc;
	/** DR-8: the composer's current pair — the own-segment reveal's starting point. */
	currentModel?: { providerProfileId: string | null; model?: string };
	closeDetail?: () => void;
}

/** Bodies longer than this get the clamped preview + toggle (the AP-23
 *  skill-library precedent: `BODY_CLAMP_AT` there); shorter bodies render
 *  whole with no toggle. A character count stands in for the rendered
 *  8-line clamp — deterministic and test-pinnable. */
const PROMPT_CLAMP_AT = 500;

function ProfileView({ profile, t, currentModel }: ProfileViewProps) {
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
					<h3 data-testid="copilot-profile-detail-name" className="font-body text-[calc(var(--ui-fs)+3px)] font-semibold text-t1">{builtinProfileDisplayName(profile.id, profile.agentKind, profile.name, t)}</h3>
					<span data-testid="copilot-profile-detail-tag">
						<MasterListTag>
							{profile.isBuiltIn ? t("copilot_profile_built_in") : t("copilot_profile_custom_tag")}
						</MasterListTag>
					</span>
				</div>
			</div>

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("copilot_profile_base_prompt")}>
					<pre
						data-testid="copilot-profile-prompt-preview"
						className={cn(
							"whitespace-pre-wrap break-words rounded bg-s2 p-2 font-mono text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t2",
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

				{/* DR-8 (mockup §11): the model block (the `agent_profile_model_label` row) between the prompt preview and
				    the tools — chat-target hosts only (the sidechat's profiles; the
				    mini-app and script copilots' modal surfaces stay byte-identical, the
				    plan's own must-stay-true). Built-in rows included: the model is a
				    SETTING, not an edit — the read-only guard protects prompt/tools only. */}
				{getAgentHost(profile.agentKind).profileAssignment.target === "chat" && (
					<PreviewRow label={t("agent_profile_model_label")}>
						<AgentProfileModelBlock
							agentKind={profile.agentKind}
							profileId={profile.id}
							currentModel={currentModel}
							t={t}
						/>
					</PreviewRow>
				)}

				<PreviewRow label={t("copilot_profile_tools")}>
					{enabledTools.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{enabledTools.map((key) => (
								<span key={key} className="rounded-full border border-border px-2 py-0.5 font-mono text-[calc(var(--ui-fs)-3px)] text-t2">{resolveAgentProfileToolLabel(t, profile.agentKind, key)}</span>
							))}
						</div>
					) : (
						<span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("copilot_profile_no_skills")}</span>
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
				<p className="font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3">{t("copilot_profile_base_prompt_hint")}</p>
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
									"cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[calc(var(--ui-fs)-3px)] transition-colors",
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
			<label className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.06em] text-t3">{label}</label>
			{children}
			{hint && <p className="font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3">{hint}</p>}
		</div>
	);
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.06em] text-t3">{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}
