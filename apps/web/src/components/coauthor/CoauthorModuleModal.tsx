import { useEffect, useState } from "react";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { Icons } from "../shared/icons.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import {
	listCoauthorModulesAction,
	setCoauthorModuleAction,
	createCoauthorModuleAction,
	updateCoauthorModuleAction,
	deleteCoauthorModuleAction,
} from "../../stores/api-actions/chat-actions.js";
import { useT } from "../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../lib/cn.js";
import type { CoauthorModule, CoauthorModuleCreate, CoauthorToolSet } from "@vibe-tavern/api-contracts";

/**
 * Tool options keyed by CoauthorToolSet field. Rendered as checkboxes in the
 * editor so the user can toggle which edits a module is allowed to propose.
 * Order is fixed for a stable layout. Mirrors the backend tool registry.
 */
const TOOL_OPTIONS: Array<{ key: keyof CoauthorToolSet; label: string }> = [
	{ key: "edit_profile", label: "edit_profile" },
	{ key: "edit_personality", label: "edit_personality" },
	{ key: "edit_scenario", label: "edit_scenario" },
	{ key: "edit_examples", label: "edit_examples" },
	{ key: "edit_greeting", label: "edit_greeting" },
	{ key: "add_alt_greeting", label: "add_alt_greeting" },
	{ key: "edit_alt_greeting", label: "edit_alt_greeting" },
];

/**
 * Skill IDs backed by `services/api/assets/coauthor/skills/<id>.md`. Each
 * toggle controls whether the module allows that skill's prompt overlay to be
 * autodetected and injected during assembly.
 */
const SKILL_OPTIONS = [
	"general-writing",
	"profile-analysis",
	"profile-overview",
	"personality-deepen",
	"dialogue-generation",
] as const;

const DEFAULT_MODULE_ID = "default";
const EMPTY_DRAFT: ModuleDraft = {
	name: "",
	description: "",
	basePrompt: "",
	openingMessage: "",
	skillIds: [],
	toolSet: {},
	maxSteps: 5,
};

interface ModuleDraft {
	name: string;
	description: string;
	basePrompt: string;
	openingMessage: string;
	skillIds: string[];
	toolSet: CoauthorToolSet;
	maxSteps: number;
}

function moduleToDraft(m: CoauthorModule): ModuleDraft {
	return {
		name: m.name,
		description: m.description,
		basePrompt: m.basePrompt,
		openingMessage: m.openingMessage,
		skillIds: [...m.skillIds],
		toolSet: { ...m.toolSet },
		maxSteps: m.maxSteps,
	};
}

function draftToCreateInput(d: ModuleDraft): CoauthorModuleCreate {
	return {
		name: d.name.trim(),
		description: d.description.trim(),
		basePrompt: d.basePrompt,
		openingMessage: d.openingMessage,
		skillIds: d.skillIds,
		toolSet: d.toolSet,
		maxSteps: d.maxSteps,
	};
}

type DetailMode = "view" | "edit" | "create";

/**
 * CS-25: full author-module manager (MasterDetail). Built-in seed modules are
 * read-only (click to preview); user modules can be created, edited, and
 * deleted. Activating a module still sets it per-chat. The editor form covers
 * every field the backend persists: name, description, inline base prompt,
 * opening message, skill toggles, tool-set checkboxes, and maxSteps.
 *
 * `{{char}}`/`{{user}}` stay literal everywhere — co-author edits a template
 * (CS-26); the hints on base prompt and opening message fields remind the user.
 */
export function CoauthorModuleModal() {
	const { t } = useT();
	const isOpen = useModalStore((s) => s.isCoauthorModuleModalOpen);
	const setIsOpen = useModalStore((s) => s.setCoauthorModuleModalOpen);

	const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
	const rawActiveModuleId = useSnapshotStore((s) => s.activeChat?.coauthorModuleId ?? null);
	// Mirror the backend registry's null→default fallback so the active row is
	// highlighted even when no module has been explicitly chosen yet.
	const activeModuleId = rawActiveModuleId ?? DEFAULT_MODULE_ID;

	const [modules, setModules] = useState<CoauthorModule[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailMode, setDetailMode] = useState<DetailMode>("view");
	const [draft, setDraft] = useState<ModuleDraft>(EMPTY_DRAFT);
	const [dirty, setDirty] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

	const loadModules = async () => {
		setIsLoading(true);
		try {
			const list = await listCoauthorModulesAction();
			setModules(list);
			setSelectedId((prev) => prev ?? activeModuleId);
		} catch {
			setModules([]);
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		if (isOpen) void loadModules();
		// Reset editor state when the modal closes so reopening starts fresh.
		if (!isOpen) {
			setDetailMode("view");
			setDirty(false);
			setConfirmDeleteId(null);
			setConfirmDiscardOpen(false);
		}
	}, [isOpen]);

	const selected = modules.find((m) => m.id === selectedId) ?? null;
	const isSelectedActive = selected !== null && selected.id === activeModuleId;

	const handleSelect = (id: string, openDetail?: () => void) => {
		// Guard: don't abandon unsaved editor changes without confirmation.
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

	const handleEdit = (module: CoauthorModule, openDetail?: () => void) => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setDraft(moduleToDraft(module));
		setSelectedId(module.id);
		setDetailMode("edit");
		openDetail?.();
	};

	const updateDraft = <K extends keyof ModuleDraft>(key: K, value: ModuleDraft[K]) => {
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

	const toggleTool = (key: keyof CoauthorToolSet) => {
		setDraft((prev) => ({
			...prev,
			toolSet: { ...prev.toolSet, [key]: !prev.toolSet[key] },
		}));
		setDirty(true);
	};

	const handleSave = async () => {
		// Client-side validation mirrors the Zod schemas (name + basePrompt non-empty).
		if (!draft.name.trim()) {
			toast.error(t("coauthor.module.name_required"));
			return;
		}
		if (!draft.basePrompt.trim()) {
			toast.error(t("coauthor.module.base_prompt_required"));
			return;
		}
		const input = draftToCreateInput(draft);
		try {
			if (detailMode === "create") {
				const created = await createCoauthorModuleAction(input);
				setModules((prev) => [...prev, created]);
				setSelectedId(created.id);
			} else if (detailMode === "edit" && selectedId) {
				const updated = await updateCoauthorModuleAction(selectedId, input);
				setModules((prev) => prev.map((m) => (m.id === selectedId ? updated : m)));
			}
			setDetailMode("view");
			setDirty(false);
		} catch {
			toast.error(t(detailMode === "create" ? "coauthor.module.create_failed" : "coauthor.module.update_failed"));
		}
	};

	const handleConfirmDelete = async () => {
		const id = confirmDeleteId;
		setConfirmDeleteId(null);
		if (!id) return;
		try {
			await deleteCoauthorModuleAction(id);
			setModules((prev) => prev.filter((m) => m.id !== id));
			if (selectedId === id) {
				setSelectedId(DEFAULT_MODULE_ID);
				setDetailMode("view");
			}
		} catch {
			toast.error(t("coauthor.module.delete_failed"));
		}
	};

	const handleActivate = async () => {
		if (!chatId || !selected || isSelectedActive) return;
		try {
			await setCoauthorModuleAction(chatId, selected.id);
			setIsOpen(false);
		} catch {
			toast.error(t("coauthor.module.switch_failed"));
		}
	};

	const close = () => {
		if (dirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		setIsOpen(false);
	};

	const isEditing = detailMode === "edit" || detailMode === "create";

	return (
		<>
			{confirmDiscardOpen && (
				<DestructiveConfirmModal
					title={t("coauthor.module.unsaved_changes")}
					body={<>{t("coauthor.module.unsaved_changes")}</>}
					confirmLabel={t("coauthor.module.discard")}
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
					title={t("coauthor.module.delete_confirm_title")}
					body={<>{t("coauthor.module.delete_confirm_body")}</>}
					confirmLabel={t("coauthor.module.delete")}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setConfirmDeleteId(null)}
				/>
			)}
			<MasterDetailModal
				isOpen={isOpen}
				onClose={close}
				title={t("coauthor.module.title")}
				subtitle={t("coauthor.module.manager_subtitle")}
				dirty={dirty}
				headerActions={
					<button
						type="button"
						data-testid="module-new-btn"
						className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 font-ui text-[12px] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98]"
						onClick={() => handleNew()}
					>
						<Icons.Plus className="h-3.5 w-3.5" />
						{t("coauthor.module.new")}
					</button>
				}
				masterContent={({ openDetail }) => (
					<ModuleList
						modules={modules}
						isLoading={isLoading}
						selectedId={selectedId}
						activeModuleId={activeModuleId}
						detailMode={detailMode}
						t={t}
						onSelect={(id) => handleSelect(id, openDetail)}
						onEdit={(m) => handleEdit(m, openDetail)}
						onDelete={(id) => setConfirmDeleteId(id)}
					/>
				)}
				detailContent={({ closeDetail }) =>
					isEditing ? (
						<ModuleEditor
							draft={draft}
							mode={detailMode}
							t={t}
							onUpdate={updateDraft}
							onToggleSkill={toggleSkill}
							onToggleTool={toggleTool}
						/>
					) : selected ? (
						<ModuleView
							module={selected}
							t={t}
							isSelectedActive={isSelectedActive}
							onEdit={() => handleEdit(selected)}
							onDelete={() => setConfirmDeleteId(selected.id)}
							closeDetail={closeDetail}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{t("coauthor.module.empty")}</div>
					)
				}
				footer={
					isEditing ? (
						<div className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-6 py-3">
							<button
								type="button"
								data-testid="module-cancel-btn"
								className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1"
								onClick={() => { setDetailMode("view"); setDirty(false); }}
							>
								{t("coauthor.module.cancel")}
							</button>
							<button
								type="button"
								data-testid="module-save-btn"
								className="cursor-pointer rounded-md bg-accent px-4 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98]"
								onClick={() => { void handleSave(); }}
							>
								{t("coauthor.module.save")}
							</button>
						</div>
					) : selected && !isSelectedActive ? (
						<div className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-6 py-3">
							<button
								type="button"
								data-testid="module-activate-btn"
								className="cursor-pointer rounded-md bg-accent px-4 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98]"
								onClick={() => { void handleActivate(); }}
							>
								{t("coauthor.module.activate")}
							</button>
						</div>
					) : null
				}
			/>
		</>
	);
}

// ─── Master list ────────────────────────────────────────────────────────

interface ModuleListProps {
	modules: CoauthorModule[];
	isLoading: boolean;
	selectedId: string | null;
	activeModuleId: string;
	detailMode: DetailMode;
	t: (key: string) => string;
	onSelect: (id: string) => void;
	onEdit: (m: CoauthorModule) => void;
	onDelete: (id: string) => void;
}

function ModuleList({ modules, isLoading, selectedId, activeModuleId, detailMode, t, onSelect, onEdit, onDelete }: ModuleListProps) {
	if (isLoading) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t("coauthor.module.loading")}</div>;
	}
	if (modules.length === 0) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t("coauthor.module.empty")}</div>;
	}
	return (
		<ul className="flex flex-col py-1">
			{modules.map((m) => {
				const isActive = m.id === activeModuleId;
				const isSelected = (m.id === selectedId && detailMode === "view") || (detailMode === "edit" && m.id === selectedId);
				return (
					<li key={m.id}>
						<div
							className={cn(
								"group flex w-full cursor-pointer flex-col gap-0.5 border-l-2 px-3 py-2.5 text-left transition-colors",
								isSelected ? "bg-s2" : "hover:bg-s2",
								isActive ? "border-accent" : "border-transparent",
							)}
							onClick={() => onSelect(m.id)}
						>
							<span className="flex items-center gap-1.5 font-ui text-[13px] font-medium text-t1">
								{m.name}
								{isActive && (
									<span className="inline-flex h-3.5 w-3.5 items-center justify-center text-accent">
										<Icons.Check />
									</span>
								)}
								{m.isBuiltIn ? (
									<span className="ml-auto rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">
										{t("coauthor.module.built_in")}
									</span>
								) : (
									<span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											data-testid={`module-edit-btn-${m.id}`}
											className="flex h-5 w-5 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1"
											title={t("coauthor.module.edit")}
											onClick={() => onEdit(m)}
										>
											<Icons.Edit className="h-3 w-3" />
										</button>
										<button
											type="button"
											data-testid={`module-delete-btn-${m.id}`}
											className="flex h-5 w-5 items-center justify-center rounded text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text"
											title={t("coauthor.module.delete")}
											onClick={() => onDelete(m.id)}
										>
											<Icons.Trash className="h-3 w-3" />
										</button>
									</span>
								)}
							</span>
							<span className="line-clamp-2 font-ui text-[11px] text-t3">{m.description}</span>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

// ─── Read-only view (built-in + user modules) ───────────────────────────

interface ModuleViewProps {
	module: CoauthorModule;
	t: (key: string) => string;
	isSelectedActive: boolean;
	onEdit: () => void;
	onDelete: () => void;
	closeDetail?: () => void;
}

function ModuleView({ module, t, onEdit, onDelete }: ModuleViewProps) {
	const enabledTools = TOOL_OPTIONS.filter(({ key }) => module.toolSet[key] === true);
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{module.name}</h3>
					{module.isBuiltIn ? (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("coauthor.module.built_in")}</span>
					) : (
						<span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("coauthor.module.user")}</span>
					)}
				</div>
				<p className="mt-1 font-ui text-[13px] leading-relaxed text-t2">{module.description}</p>
			</div>

			{!module.isBuiltIn && (
				<div className="flex gap-2">
					<button
						type="button"
						data-testid="module-view-edit-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1"
						onClick={onEdit}
					>
						<Icons.Edit className="h-3 w-3" />
						{t("coauthor.module.edit")}
					</button>
					<button
						type="button"
						data-testid="module-view-delete-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t3 transition-colors hover:border-danger hover:text-danger-text"
						onClick={onDelete}
					>
						<Icons.Trash className="h-3 w-3" />
						{t("coauthor.module.delete")}
					</button>
				</div>
			)}

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("coauthor.module.base_prompt")}>
					<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-s2 p-2 font-mono text-[11px] leading-relaxed text-t2">{module.basePrompt}</pre>
				</PreviewRow>

				{module.openingMessage && (
					<PreviewRow label={t("coauthor.module.opening_message_label")}>
						<p className="font-ui text-[12px] leading-relaxed text-t2">{module.openingMessage}</p>
					</PreviewRow>
				)}

				<PreviewRow label={t("coauthor.module.max_steps")}>
					<span className="font-mono text-[13px] text-t1">{module.maxSteps}</span>
				</PreviewRow>

				<PreviewRow label={t("coauthor.module.skills")}>
					{module.skillIds.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{module.skillIds.map((id) => (
								<span key={id} className="rounded-full border border-border bg-s1 px-2 py-0.5 font-mono text-[11px] text-t2">{id}</span>
							))}
						</div>
					) : (
						<span className="font-ui text-[12px] text-t3">{t("coauthor.module.no_skills")}</span>
					)}
				</PreviewRow>

				<PreviewRow label={t("coauthor.module.tools")}>
					{enabledTools.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{enabledTools.map(({ key, label }) => (
								<span key={key} className="rounded-full border border-border bg-s1 px-2 py-0.5 font-mono text-[11px] text-t2">{label}</span>
							))}
						</div>
					) : (
						<span className="font-ui text-[12px] text-t3">{t("coauthor.module.no_skills")}</span>
					)}
				</PreviewRow>
			</dl>
		</div>
	);
}

// ─── Editor form (create + edit) ────────────────────────────────────────

interface ModuleEditorProps {
	draft: ModuleDraft;
	mode: DetailMode;
	t: (key: string) => string;
	onUpdate: <K extends keyof ModuleDraft>(key: K, value: ModuleDraft[K]) => void;
	onToggleSkill: (skillId: string) => void;
	onToggleTool: (key: keyof CoauthorToolSet) => void;
}

function ModuleEditor({ draft, t, onUpdate, onToggleSkill, onToggleTool }: ModuleEditorProps) {
	return (
		<div className="flex flex-col gap-4" data-testid="module-editor">
			<Field label={t("coauthor.module.name_label")}>
			<input
					type="text"
					data-testid="module-name-input"
					className="w-full rounded border border-border bg-bg px-2 py-1.5 font-ui text-[13px] text-t1 outline-none focus:border-accent"
					placeholder={t("coauthor.module.name_placeholder")}
					value={draft.name}
					onChange={(e) => onUpdate("name", e.target.value)}
				/>
			</Field>

			<Field label={t("coauthor.module.description_label")}>
				<textarea
					rows={2}
					className="w-full resize-y rounded border border-border bg-bg px-2 py-1.5 font-ui text-[13px] text-t1 outline-none focus:border-accent"
					placeholder={t("coauthor.module.description_placeholder")}
					value={draft.description}
					onChange={(e) => onUpdate("description", e.target.value)}
				/>
			</Field>

			<Field label={t("coauthor.module.base_prompt")} hint={t("coauthor.module.base_prompt_hint")}>
				<textarea
					rows={8}
					className="w-full resize-y rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-t1 outline-none focus:border-accent"
					value={draft.basePrompt}
					onChange={(e) => onUpdate("basePrompt", e.target.value)}
				/>
			</Field>

			<Field label={t("coauthor.module.opening_message_label")} hint={t("coauthor.module.opening_message_hint")}>
				<textarea
					rows={3}
					className="w-full resize-y rounded border border-border bg-bg px-2 py-1.5 font-ui text-[12px] text-t1 outline-none focus:border-accent"
					value={draft.openingMessage}
					onChange={(e) => onUpdate("openingMessage", e.target.value)}
				/>
			</Field>

			<Field label={t("coauthor.module.skills")}>
				<div className="flex flex-wrap gap-1.5">
					{SKILL_OPTIONS.map((skillId) => {
						const active = draft.skillIds.includes(skillId);
						return (
							<button
								key={skillId}
								type="button"
								className={cn(
									"cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
									active ? "border-accent bg-accent-dim text-accent-t" : "border-border text-t3 hover:text-t1",
								)}
								onClick={() => onToggleSkill(skillId)}
							>
								{skillId}
							</button>
						);
					})}
				</div>
			</Field>

			<Field label={t("coauthor.module.tools")}>
				<div className="flex flex-wrap gap-1.5">
					{TOOL_OPTIONS.map(({ key, label }) => {
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
								{label}
							</button>
						);
					})}
				</div>
			</Field>

			<Field label={t("coauthor.module.max_steps")} hint={t("coauthor.module.max_steps_hint")}>
				<input
					type="number"
					min={1}
					max={20}
					className="w-20 rounded border border-border bg-bg px-2 py-1.5 font-mono text-[13px] text-t1 outline-none focus:border-accent"
					value={draft.maxSteps}
					onChange={(e) => onUpdate("maxSteps", Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
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
