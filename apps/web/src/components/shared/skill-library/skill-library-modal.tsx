import { useEffect, useRef, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../MasterDetailModal.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { EmptyState } from "../empty-state.js";
import { Icons } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import type { TDynamic } from "../../../i18n/locale-helpers.js";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";
import type { SkillLibraryAdapter, SkillLibraryLabels, SkillLibraryTestids } from "./skill-library-adapter.js";

/**
 * THE one skill library modal (AP-22, AGENT_SHELL_POLISH Wave 5) — a pure
 * merge that absorbed both pre-merge implementations whole:
 * `AgentSkillModal.tsx` (agent copilot, per-kind libraries, controlled
 * open/close) and `CoauthorSkillModal.tsx` (global modal-store, delete
 * reference guard). Both remain as thin wrappers that bind their store, their
 * i18n namespace, and their testids through a {@link SkillLibraryAdapter};
 * the wrappers carry NO markup. Any future copy of this UI is fork #1 OF this
 * modal — extend the adapter instead.
 *
 * Mirrors the canonical `CoauthorModuleModal` / `ProviderModal` layout
 * (shared `MasterDetailModal` shell, scrollable master rows with `border-l-2`
 * + mobile drill-down, stable footer). No hand-rolled modal scaffolding.
 * Lists the merged metadata-only catalog (built-in + user skills, user
 * shadows builtin), imports a skill tree via a folder upload (each file's
 * `webkitRelativePath` is its relative path — the server validates the whole
 * tree atomically), inspects a skill's metadata, and deletes user skills
 * (built-ins are read-only — the server rejects their delete).
 */
export function SkillLibraryModal({ isOpen, onClose, adapter }: {
	isOpen: boolean;
	onClose: () => void;
	adapter: SkillLibraryAdapter;
}) {
	const { tDynamic } = useT();
	const { labels, testids } = adapter;

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isImporting, setIsImporting] = useState(false);
	/** Pending delete: the skill id + the module names that still reference it
	 *  (empty when no module references the skill or no guard is supplied). */
	const [pendingDelete, setPendingDelete] = useState<{ id: string; referencedBy: string[] } | null>(null);
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
		}
		// `adapter.load` is stable per the adapter's contract; the rest of the
		// adapter object is rebuilt each wrapper render.
	}, [isOpen, adapter.load]);

	const selected = adapter.entries.find((e) => e.id === selectedId) ?? null;

	const handleSelect = (id: string, openDetail?: () => void) => {
		setSelectedId(id);
		openDetail?.();
	};

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
			<MasterDetailModal
				isOpen={isOpen}
				onClose={onClose}
				title={tDynamic(labels.title)}
				subtitle={tDynamic(labels.subtitle)}
				headerActions={
					<button
						type="button"
						data-testid={testids.importBtn}
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1 disabled:opacity-40 disabled:cursor-not-allowed"
						disabled={isImporting}
						onClick={handleImportClick}
					>
						<Icons.Import className="h-3.5 w-3.5" />
						{isImporting ? tDynamic(labels.importing) : tDynamic(labels.import)}
					</button>
				}
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
						onDelete={(skill) => { void handleDelete(skill); }}
					/>
				)}
				detailContent={() =>
					selected ? (
						<SkillDetail
							skill={selected}
							labels={labels}
							testids={testids}
							t={tDynamic}
							onDelete={() => { void handleDelete(selected); }}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{tDynamic(labels.emptyDetail)}</div>
					)
				}
				footer={
					<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3">
						<button
							type="button"
							className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1"
							onClick={onClose}
						>
							{tDynamic(labels.close)}
						</button>
					</div>
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
	onDelete: (skill: SkillCatalogEntryDto) => void;
}

function SkillList({ entries, isLoading, hasLoaded, selectedId, labels, testids, t, onSelect, onDelete }: SkillListProps) {
	if (isLoading && !hasLoaded) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t(labels.loading)}</div>;
	}
	return (
		<div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
			<div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
				{t(labels.listLabel)}
			</div>
			<div className="flex-1 overflow-y-auto">
				{entries.length === 0 ? (
					<div className="flex h-full items-center justify-center px-2">
						<EmptyState
							icon={<Icons.Book />}
							title={t(labels.empty)}
							sub={t(labels.emptySub)}
						/>
					</div>
				) : (
					entries.map((skill) => {
						const isSelected = skill.id === selectedId;
						const isUser = skill.source === "user";
						const rowTestId = testids.row?.(skill.id);
						return (
							<div
								key={`${skill.source}:${skill.id}`}
								{...(rowTestId ? { "data-testid": rowTestId } : {})}
								onPointerDown={() => onSelect(skill.id)}
								className={cn(
									"group flex cursor-pointer items-center gap-3 border-l-2 min-h-[56px] pl-4 pr-2 touch-manipulation sm:transition-colors",
									isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
								)}
							>
								<Icons.Book className="h-3.5 w-3.5 shrink-0 text-t3" />
								<div className="min-w-0 flex-1 py-2">
									<div className="flex min-w-0 items-center gap-1.5">
										<span className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isSelected ? "text-accent-t" : "text-t2")}>
											{skill.name}
										</span>
										{skill.shadowsBuiltin && (
											<span className="shrink-0 rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t(labels.shadowTitle)}>
												{t(labels.shadow)}
											</span>
										)}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px] text-t4">{skill.id}</div>
								</div>
								{isUser && (
									<div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											data-testid={testids.deleteBtn(skill.id)}
											className="flex h-6 w-6 items-center justify-center rounded text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text md:opacity-0 md:group-hover:opacity-100"
											title={t(labels.delete)}
											onClick={() => onDelete(skill)}
										>
											<Icons.Trash className="h-3 w-3" />
										</button>
									</div>
								)}
								<MasterDetailMobileDrillDown onSelect={() => onSelect(skill.id)} className="py-3" />
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

// ─── Detail (metadata inspector) ────────────────────────────────────────

interface SkillDetailProps {
	skill: SkillCatalogEntryDto;
	labels: SkillLibraryLabels;
	testids: SkillLibraryTestids;
	t: TDynamic;
	onDelete: () => void;
}

function SkillDetail({ skill, labels, testids, t, onDelete }: SkillDetailProps) {
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{skill.name}</h3>
					{skill.source === "user" ? (
						<span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t(labels.user)}</span>
					) : (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t(labels.builtIn)}</span>
					)}
					{skill.shadowsBuiltin && (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t(labels.shadowTitle)}>{t(labels.shadow)}</span>
					)}
				</div>
				<p className="mt-1 font-ui text-[13px] leading-relaxed text-t2">{skill.description}</p>
			</div>

			{skill.source === "user" && (
				<button
					type="button"
					data-testid={testids.detailDeleteBtn}
					className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t3 transition-colors hover:border-danger hover:text-danger-text"
					onClick={onDelete}
				>
					<Icons.Trash className="h-3 w-3" />
					{t(labels.delete)}
				</button>
			)}

			<dl className="flex flex-col gap-3">
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
			</dl>

			<p className="font-ui text-[11px] leading-relaxed text-t3">{t(labels.inspectHint)}</p>
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
