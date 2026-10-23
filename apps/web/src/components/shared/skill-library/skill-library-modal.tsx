import { useEffect, useRef, useState } from "react";
import {
	MasterDetailModal,
	MasterDetailFooter,
	MasterDetailMobileDrillDown,
	type MasterDetailParentBack,
} from "../MasterDetailModal.js";
import { AnimatedDisclosure } from "../AnimatedDisclosure.js";
import { ConfirmCloseModal } from "../confirm-close-modal.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { EmptyState } from "../empty-state.js";
import { Icons } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import type { TDynamic } from "../../../i18n/locale-helpers.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import type { SkillCatalogEntryDto, SkillContentDto } from "@vibe-tavern/api-contracts";
import type { SkillLibraryAdapter, SkillLibraryLabels, SkillLibraryTestids } from "./skill-library-adapter.js";
import { BLANK_SKILL_DRAFT, SkillEditor, type SkillDraft } from "./skill-editor.js";

/**
 * THE one skill library modal (AP-22, AGENT_SHELL_POLISH Wave 5 — a pure
 * merge of `AgentSkillModal` + `CoauthorSkillModal` markup; AP-23 applies the
 * mockup §6–7 visual design to that merged surface; AP-23d adds the mockup §8
 * skill editor). A thin `SkillLibraryModal` view over a {@link SkillLibraryAdapter}:
 * the agent copilot wrapper (per-kind, controlled open/close) and the
 * global-store Co-Author wrapper bind their store, their i18n namespace, and
 * their testids; the wrappers carry NO markup. Any future copy of this UI is
 * fork #1 OF this modal — extend the adapter.
 *
 * Layout (mockup §6–7): master rows show name + one-line description (no id,
 * no per-row actions); the detail shows name + «свой»/«встроенный» tag, the
 * description, a clamped «Текст навыка» preview (AP-21 `body`, lazy-loaded
 * when the detail opens) with «Показать целиком»/«Свернуть», and a collapsed
 * «Технические детали» disclosure (id, path, source, shadow note, file list).
 * The footer is the shared `MasterDetailFooter` (view: Edit / Duplicate /
 * Delete left for user skills, Duplicate only for built-ins, Close right;
 * edit: Cancel / Save right). The new-skill entry docks at the list bottom
 * ABOVE the import dock; the empty
 * library shows the explanation + import CTA. The editor (`skill-editor.tsx`)
 * is an ADDITIONAL detail mode — the AP-23 view stays untouched.
 */
export function SkillLibraryModal({ isOpen, onClose, adapter, parentBack }: {
	isOpen: boolean;
	onClose: () => void;
	adapter: SkillLibraryAdapter;
	/** Optional drill-down parent (AP-3): absent = no back link. */
	parentBack?: MasterDetailParentBack;
}) {
	const { tDynamic } = useT();
	const { labels, testids } = adapter;
	const readContent = adapter.readContent;

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isImporting, setIsImporting] = useState(false);
	/** Editor session (AP-23d, mockup §8): `new` = blank or duplicate-prefilled
	 *  (both save via create — the folder id derives from the name
	 *  server-side), `edit` = an existing user skill (saves via update).
	 *  While set, the detail pane renders `SkillEditor` instead of the view. */
	const [editSession, setEditSession] = useState<{ mode: "new" } | { mode: "edit"; id: string } | null>(null);
	const [draft, setDraft] = useState<SkillDraft>(BLANK_SKILL_DRAFT);
	/** Draft snapshot at session start — the dirty baseline. The body slot is
	 *  back-filled when the lazy content arrives (see the fill effect). */
	const [draftBase, setDraftBase] = useState<SkillDraft>(BLANK_SKILL_DRAFT);
	/** Skill id whose lazy body still has to land in the draft (edit/duplicate
	 *  started before the view's `readContent` resolved — never clobbers a
	 *  body the user already typed). */
	const [bodySourceId, setBodySourceId] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	/** Guarded exit (AP-23d dirty guard, the PromptManagerModal convention):
	 *  leaving a dirty editor — modal close, Cancel, or selecting another
	 *  row — asks via `ConfirmCloseModal` instead of silently discarding.
	 *  A clean editor exits immediately (no guard). */
	const [pendingExit, setPendingExit] = useState<null | { kind: "close" } | { kind: "cancel" } | { kind: "select"; id: string }>(null);
	/** Pending delete: the skill id + the module names that still reference it
	 *  (empty when no module references the skill or no guard is supplied). */
	const [pendingDelete, setPendingDelete] = useState<{ id: string; referencedBy: string[] } | null>(null);
	/** Lazy AP-21 skill body for the open detail (reset per selection). */
	const [content, setContent] = useState<SkillContentDto | null>(null);
	const [isContentLoading, setIsContentLoading] = useState(false);
	const [contentFailed, setContentFailed] = useState(false);
	const [isBodyExpanded, setIsBodyExpanded] = useState(false);
	const [isTechOpen, setIsTechOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	/** Merged ref: keep the element for `.click()`/reset AND set the non-standard
	 *  `webkitdirectory` attribute (absent from lib.dom TS types → imperative). */
	const setFolderInput = (el: HTMLInputElement | null) => {
		fileInputRef.current = el;
		if (el) el.setAttribute("webkitdirectory", "");
	};

	useEffect(() => {
		if (isOpen) void adapter.load();
		if (!isOpen) {
			setSelectedId(null);
			setPendingDelete(null);
			setIsImporting(false);
			setContent(null);
			setIsContentLoading(false);
			setContentFailed(false);
			setIsBodyExpanded(false);
			setIsTechOpen(false);
			setEditSession(null);
			setDraft(BLANK_SKILL_DRAFT);
			setDraftBase(BLANK_SKILL_DRAFT);
			setBodySourceId(null);
			setIsSaving(false);
			setPendingExit(null);
		}
		// `adapter.load` is stable per the adapter's contract; the rest of the
		// adapter object is rebuilt each wrapper render.
	}, [isOpen, adapter.load]);

	const selected = adapter.entries.find((e) => e.id === selectedId) ?? null;
	const isDirty = editSession !== null &&
		(draft.name !== draftBase.name || draft.description !== draftBase.description || draft.body !== draftBase.body);

	// Late body arrival for an edit/duplicate session started before the
	// view's `readContent` resolved: back-fill the untouched body slot once.
	// A body the user already typed is never clobbered.
	useEffect(() => {
		if (!editSession || !bodySourceId || !content || content.id !== bodySourceId) return;
		if (draft.body !== draftBase.body) return;
		setDraft({ ...draftBase, body: content.body });
		setDraftBase({ ...draftBase, body: content.body });
		setBodySourceId(null);
	});

	const handleSelect = (id: string, openDetail?: () => void) => {
		openDetail?.();
		if (!editSession) {
			setSelectedId(id);
			return;
		}
		// List navigation out of a dirty editor asks first (same guard as
		// close/cancel); a clean editor switches immediately.
		if (isDirty) {
			setPendingExit({ kind: "select", id });
			return;
		}
		setEditSession(null);
		setBodySourceId(null);
		setSelectedId(id);
	};

	// Lazy-load the skill body whenever the detail opens. Stale responses
	// (selection changed or modal closed mid-flight) are dropped; the loading
	// line and the silent failure are both quiet by contract.
	useEffect(() => {
		if (!isOpen || !selectedId) return;
		let cancelled = false;
		setContent(null);
		setContentFailed(false);
		setIsContentLoading(true);
		setIsBodyExpanded(false);
		setIsTechOpen(false);
		void readContent(selectedId).then(
			(body) => {
				if (cancelled) return;
				setContent(body);
				setIsContentLoading(false);
			},
			() => {
				if (cancelled) return;
				setContent(null);
				setContentFailed(true);
				setIsContentLoading(false);
			},
		);
		return () => { cancelled = true; };
		// `readContent` is stable per the adapter's contract.
	}, [isOpen, selectedId, readContent]);

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleFilesPicked = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setIsImporting(true);
		try {
			const ids = await adapter.importTree(Array.from(files));
			toast.success(tDynamic(labels.importSuccess, { n: ids.length, ids: ids.join(", ") }));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : tDynamic(labels.importFailed));
		} finally {
			setIsImporting(false);
			// Reset so picking the same folder again fires `change`.
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	/** Delete entry point: consult the adapter's reference guard (if any),
	 *  then open a confirm that names the modules still binding the skill. */
	const handleDelete = async (skill: SkillCatalogEntryDto) => {
		const guard = adapter.referenceGuard;
		if (!guard) {
			setPendingDelete({ id: skill.id, referencedBy: [] });
			return;
		}
		try {
			const referencedBy = await guard.findReferencingModules(skill.id);
			setPendingDelete({ id: skill.id, referencedBy });
		} catch {
			// If the module list can't be loaded, still proceed to a plain confirm
			// (no guard) so the user isn't blocked from deleting a skill.
			setPendingDelete({ id: skill.id, referencedBy: [] });
		}
	};

	const handleConfirmDelete = async () => {
		const id = pendingDelete?.id ?? null;
		setPendingDelete(null);
		if (!id) return;
		try {
			await adapter.remove(id);
			if (selectedId === id) setSelectedId(null);
			toast.success(tDynamic(labels.deleted));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : tDynamic(labels.deleteFailed));
		}
	};

	/** Editor entry points (AP-23d, mockup §8). `new` (blank or duplicate
	 *  prefill) saves via create; `edit` (an existing user skill) via update.
	 *  The body slot takes the lazy content when it already landed for this
	 *  skill, else the fill effect back-fills it on arrival. */
	const beginSession = (session: { mode: "new" } | { mode: "edit"; id: string }, base: SkillDraft, skill: SkillCatalogEntryDto | null) => {
		setDraft(base);
		setDraftBase(base);
		setBodySourceId(skill && (!content || content.id !== skill.id) ? skill.id : null);
		setEditSession(session);
	};

	const handleStartNew = () => {
		beginSession({ mode: "new" }, BLANK_SKILL_DRAFT, null);
	};

	const handleStartEdit = (skill: SkillCatalogEntryDto) => {
		beginSession({ mode: "edit", id: skill.id }, {
			name: skill.name,
			description: skill.description,
			body: content && content.id === skill.id ? content.body : "",
		}, skill);
	};

	const handleStartDuplicate = (skill: SkillCatalogEntryDto) => {
		beginSession({ mode: "new" }, {
			name: tDynamic(labels.copyName, { name: skill.name }),
			description: skill.description,
			body: content && content.id === skill.id ? content.body : "",
		}, skill);
	};

	/** Save — create for `new` (blank + duplicate alike: the folder id
	 *  derives from the copy name server-side), update for `edit`. The
	 *  stores refresh the catalog, so on success the detail returns to the
	 *  VIEW of the saved skill (a create selects the new entry). */
	const handleSave = async () => {
		if (!editSession || isSaving) return;
		const input = { name: draft.name.trim(), description: draft.description, body: draft.body };
		// The button disables on a blank name; double-guard the op itself.
		if (!input.name) return;
		setIsSaving(true);
		try {
			const saved = await adapter.save(editSession.mode === "edit" ? editSession.id : null, input);
			setEditSession(null);
			setBodySourceId(null);
			setSelectedId(saved.id);
			toast.success(tDynamic(labels.saved));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : tDynamic(labels.saveFailed));
		} finally {
			setIsSaving(false);
		}
	};

	const applyExit = (exit: { kind: "close" } | { kind: "cancel" } | { kind: "select"; id: string }) => {
		setEditSession(null);
		setPendingExit(null);
		setBodySourceId(null);
		if (exit.kind === "close") onClose();
		else if (exit.kind === "select") setSelectedId(exit.id);
	};

	/** Any exit from the editor — modal close, Cancel, or list navigation.
	 *  A dirty editor asks via `ConfirmCloseModal` (the PromptManagerModal
	 *  convention); a clean one exits immediately. DECISION (mockup §8 says
	 *  only that dirty edits ask before closing): the guard covers all three
	 *  exits, since Cancel and row-switch discard just like closing. */
	const requestExit = (exit: { kind: "close" } | { kind: "cancel" } | { kind: "select"; id: string }) => {
		if (editSession && isDirty) {
			setPendingExit(exit);
			return;
		}
		applyExit(exit);
	};

	const handleRequestClose = () => {
		requestExit({ kind: "close" });
	};

	const guard = adapter.referenceGuard;

	return (
		<>
			{/* Hidden folder-upload input. `webkitdirectory` is a non-standard DOM
					attribute absent from lib.dom TS types, so it is set imperatively
					via the ref callback (no type suppression directive needed). */}
			<input
				ref={setFolderInput}
				type="file"
				multiple
				className="hidden"
				data-testid={testids.folderInput}
				onChange={(e) => { void handleFilesPicked(e.target.files); }}
			/>
			{pendingDelete && (
				<DestructiveConfirmModal
					title={tDynamic(labels.deleteConfirmTitle)}
					body={
						pendingDelete.referencedBy.length > 0 && guard ? (
							<div className="flex flex-col gap-1.5">
								<span>{tDynamic(guard.referencedBody)}</span>
								<div className="flex flex-wrap justify-center gap-1.5">
									{pendingDelete.referencedBy.map((name) => (
										<span key={name} className="rounded-full border border-danger/40 bg-danger-dim px-2 py-0.5 font-ui text-[11px] text-danger-text">{name}</span>
									))}
								</div>
								<span className="text-t4">{tDynamic(guard.referencedHint)}</span>
							</div>
						) : (
							<>{tDynamic(labels.deleteConfirmBody)}</>
						)
					}
					confirmLabel={tDynamic(labels.delete)}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
			{pendingExit && (
				<ConfirmCloseModal
					onConfirm={() => applyExit(pendingExit)}
					onCancel={() => setPendingExit(null)}
				/>
			)}
			<MasterDetailModal
				isOpen={isOpen}
				onClose={handleRequestClose}
				title={tDynamic(labels.title)}
				subtitle={tDynamic(labels.subtitle)}
				parentBack={parentBack}
				dirty={isDirty}
				masterClassName="flex w-[260px] shrink-0 flex-col border-r border-border"
				masterContent={({ openDetail }) => (
					<SkillList
						entries={adapter.entries}
						isLoading={adapter.isLoading}
						hasLoaded={adapter.hasLoaded}
						selectedId={selectedId}
						labels={labels}
						testids={testids}
						t={tDynamic}
						onSelect={(id) => handleSelect(id, openDetail)}
						onNew={() => { handleStartNew(); openDetail(); }}
						onImport={handleImportClick}
						isImporting={isImporting}
					/>
				)}
				detailContent={() =>
					editSession ? (
						<SkillEditor
							draft={draft}
							onChange={setDraft}
							labels={labels}
							testids={testids}
							t={tDynamic}
						/>
					) : selected ? (
						<SkillDetail
							skill={selected}
							content={content}
							isContentLoading={isContentLoading}
							contentFailed={contentFailed}
							isBodyExpanded={isBodyExpanded}
							isTechOpen={isTechOpen}
							onToggleBody={() => setIsBodyExpanded((v) => !v)}
							onToggleTech={() => setIsTechOpen((v) => !v)}
							labels={labels}
							testids={testids}
							t={tDynamic}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{tDynamic(labels.emptyDetail)}</div>
					)
				}
				footer={
					editSession ? (
						<MasterDetailFooter
							right={
								<>
									<button
										type="button"
										className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
										onClick={() => requestExit({ kind: "cancel" })}
									>
										{tDynamic(labels.cancel)}
									</button>
									<button
										type="button"
										disabled={!draft.name.trim() || isSaving}
										className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
										onClick={() => { void handleSave(); }}
									>
										{tDynamic(labels.save)}
									</button>
								</>
							}
						/>
					) : (
						<MasterDetailFooter
							actions={
									!selected ? [] : selected.source === "user"
										? [{
												icon: <Icons.Edit />,
												label: tDynamic(labels.edit),
												onClick: () => handleStartEdit(selected),
											}, {
												icon: <Icons.Copy />,
												label: tDynamic(labels.duplicate),
												onClick: () => handleStartDuplicate(selected),
											}, {
												icon: <Icons.Trash />,
												label: tDynamic(labels.delete),
												destructive: true,
												onClick: () => { void handleDelete(selected); },
											}]
										: [{
												icon: <Icons.Copy />,
												label: tDynamic(labels.duplicate),
												onClick: () => handleStartDuplicate(selected),
											}]
							}
							onClose={onClose}
						/>
					)
				}
			/>
		</>
	);
}

// ─── Master list ────────────────────────────────────────────────────────

interface SkillListProps {
	entries: SkillCatalogEntryDto[];
	isLoading: boolean;
	hasLoaded: boolean;
	selectedId: string | null;
	labels: SkillLibraryLabels;
	testids: SkillLibraryTestids;
	t: TDynamic;
	onSelect: (id: string) => void;
	onNew: () => void;
	onImport: () => void;
	isImporting: boolean;
}

function SkillList({ entries, isLoading, hasLoaded, selectedId, labels, testids, t, onSelect, onNew, onImport, isImporting }: SkillListProps) {
	if (isLoading && !hasLoaded) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t(labels.loading)}</div>;
	}
	// Mockup §6: rows are name + one-line description (no id, no actions).
	// «+ New skill» docks above the import at the list bottom (mockup §8); the
	// empty library (mockup §7) shows the explanation + import CTA instead of
	// the list.
	return (
		<div className="flex min-h-0 flex-1 flex-col pt-5 pb-2.5">
			<div className={cn(lblCls, "shrink-0 px-4")}>
				{t(labels.listLabel)}
			</div>
			{entries.length === 0 ? (
				<div className="flex flex-1 items-center justify-center px-2">
					<EmptyState
						icon={<Icons.Book />}
						title={t(labels.emptyTitle)}
						sub={t(labels.emptyBody)}
						cta={t(labels.importCta)}
						onCta={onImport}
					/>
				</div>
			) : (
				<>
					<div className="min-h-0 flex-1 overflow-y-auto">
						{entries.map((skill) => {
							const isSelected = skill.id === selectedId;
							const rowTestId = testids.row?.(skill.id);
							return (
								<div
									key={`${skill.source}:${skill.id}`}
									{...(rowTestId ? { "data-testid": rowTestId } : {})}
									onPointerDown={() => onSelect(skill.id)}
									className={cn(
										"group flex cursor-pointer items-center gap-2 border-l-2 py-2 pr-1 pl-4 touch-manipulation sm:transition-colors",
										isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
									)}
								>
									<div className="min-w-0 flex-1">
										<div className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isSelected ? "text-accent-t" : "text-t2")}>
											{skill.name}
										</div>
										<div className="mt-0.5 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{skill.description}</div>
									</div>
									<MasterDetailMobileDrillDown onSelect={() => onSelect(skill.id)} />
								</div>
							);
						})}
					</div>
					<button
						type="button"
						data-testid={testids.newSkillBtn}
						className="mx-2.5 mt-2 flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 font-ui text-[12px] text-t2 transition-colors hover:border-accent hover:text-t1"
						onClick={onNew}
					>
						<Icons.Plus className="h-3.5 w-3.5" />
						{t(labels.newSkill)}
					</button>
					<button
						type="button"
						data-testid={testids.importBtn}
						className="mx-2.5 mt-2 flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 font-ui text-[12px] text-t2 transition-colors hover:border-accent hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
						disabled={isImporting}
						onClick={onImport}
					>
						<Icons.Import className="h-3.5 w-3.5" />
						{isImporting ? t(labels.importing) : t(labels.importCta)}
					</button>
				</>
			)}
		</div>
	);
}

// ─── Detail (skill inspector, mockup §6) ────────────────────────────────

/** Bodies longer than this get the clamped preview + toggle; shorter bodies
 *  render whole with no toggle (nothing to expand). A character count stands
 *  in for the rendered 8-line clamp — deterministic and test-pinnable. */
const BODY_CLAMP_AT = 500;

interface SkillDetailProps {
	skill: SkillCatalogEntryDto;
	content: SkillContentDto | null;
	isContentLoading: boolean;
	contentFailed: boolean;
	isBodyExpanded: boolean;
	isTechOpen: boolean;
	onToggleBody: () => void;
	onToggleTech: () => void;
	labels: SkillLibraryLabels;
	testids: SkillLibraryTestids;
	t: TDynamic;
}

function SkillDetail({ skill, content, isContentLoading, contentFailed, isBodyExpanded, isTechOpen, onToggleBody, onToggleTech, labels, testids, t }: SkillDetailProps) {
	const body = content?.body ?? "";
	const isLong = body.length > BODY_CLAMP_AT;
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{skill.name}</h3>
					<span className="rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
						{skill.source === "user" ? t(labels.user) : t(labels.builtIn)}
					</span>
				</div>
				<p className="mt-1 font-ui text-[calc(var(--ui-fs)+1px)] leading-relaxed text-t2">{skill.description}</p>
			</div>

			{!contentFailed && (content || isContentLoading) && (
				<div>
					<div className={lblCls}>{t(labels.bodyLabel)}</div>
					{isContentLoading && !content ? (
						<p className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t(labels.contentLoading)}</p>
					) : body ? (
						<>
							<div
								data-testid={testids.contentBody}
								className={cn(
									"rounded-md bg-s2 px-3 py-2.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed break-words whitespace-pre-wrap text-t2",
									!isBodyExpanded && isLong && "line-clamp-8",
								)}
							>
								{body}
							</div>
							{isLong && (
								<button
									type="button"
									data-testid={testids.previewToggle}
									className="mt-1.5 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent transition-colors hover:text-accent-t"
									onClick={onToggleBody}
								>
									{isBodyExpanded ? t(labels.collapse) : t(labels.showFull)}
								</button>
							)}
						</>
					) : null}
				</div>
			)}

			<div>
				<button
					type="button"
					data-testid={testids.techDetailsToggle}
					aria-expanded={isTechOpen}
					className="flex cursor-pointer items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:text-t1"
					onClick={onToggleTech}
				>
					<Icons.Caret direction={isTechOpen ? "d" : "r"} />
					{t(labels.techDetails)}
					<span className="text-t4">{t(labels.techDetailsHint)}</span>
				</button>
				<AnimatedDisclosure open={isTechOpen}>
					<dl className="mt-2 flex flex-col gap-3">
						<PreviewRow label={t(labels.idLabel)}>
							<span className="font-mono text-[12px] text-t1">{skill.id}</span>
						</PreviewRow>
						<PreviewRow label={t(labels.manifestLabel)}>
							<span className="font-mono text-[11px] break-all text-t2">{skill.manifestPath}</span>
						</PreviewRow>
						<PreviewRow label={t(labels.sourceLabel)}>
							<span className="font-ui text-[12px] text-t2">
								{skill.source === "user" ? t(labels.user) : t(labels.builtIn)}
								{skill.shadowsBuiltin && ` · ${t(labels.shadow)}`}
							</span>
						</PreviewRow>
						{skill.shadowsBuiltin && (
							<p className="font-ui text-[11px] leading-relaxed text-t3">{t(labels.shadowTitle)}</p>
						)}
						{content && content.files.length > 0 && (
							<PreviewRow label={t(labels.filesLabel)}>
								<div className="flex flex-col gap-1">
									{content.files.map((file) => (
										<span key={file} className="font-mono text-[11px] break-all text-t2">{file}</span>
									))}
								</div>
							</PreviewRow>
						)}
					</dl>
				</AnimatedDisclosure>
			</div>
		</div>
	);
}

// ─── Shared field primitives ─────────────────────────────────────────────

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-ui text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}
