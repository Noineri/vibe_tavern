import { useEffect, useRef, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../shared/MasterDetailModal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { EmptyState } from "../shared/empty-state.js";
import { Icons } from "../shared/icons.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useCoauthorSkillStore } from "../../stores/coauthor-skill-store.js";
import { listCoauthorModulesAction } from "../../stores/api-actions/chat-actions.js";
import { useT, type TFunc } from "../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../lib/cn.js";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";

/**
 * CTX-S7 — Co-Author skill library manager (master-detail). Lists the merged
 * metadata-only catalog (built-in + user skills, user shadows builtin), lets the
 * user import a skill tree via a folder upload (each file's `webkitRelativePath`
 * is its relative path — the server validates the whole tree atomically),
 * inspect a skill's metadata, and delete a user skill. Deleting a skill that
 * modules still reference opens a confirm that LISTS those modules (the
 * reference guard) instead of silently leaving broken bindings.
 *
 * Mirrors the canonical `CoauthorModuleModal` / `ProviderModal` layout (shared
 * `MasterDetailModal` shell, scrollable master rows with `border-l-2` + active
 * dot + mobile drill-down, dashed affordances docked at the master-list bottom,
 * stable footer). No hand-rolled modal scaffolding.
 */
export function CoauthorSkillModal() {
	const { t } = useT();
	const isOpen = useModalStore((s) => s.isCoauthorSkillModalOpen);
	const setIsOpen = useModalStore((s) => s.setCoauthorSkillModalOpen);

	const entries = useCoauthorSkillStore((s) => s.entries);
	const isLoading = useCoauthorSkillStore((s) => s.isLoading);
	const hasLoaded = useCoauthorSkillStore((s) => s.hasLoaded);
	const load = useCoauthorSkillStore((s) => s.load);
	const importTree = useCoauthorSkillStore((s) => s.importTree);
	const remove = useCoauthorSkillStore((s) => s.remove);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isImporting, setIsImporting] = useState(false);
	/** Pending delete: the skill id + the module names that still reference it
	 *  (empty when no module references the skill). */
	const [pendingDelete, setPendingDelete] = useState<{ id: string; referencedBy: string[] } | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	/** Merged ref: keep the element for `.click()`/reset AND set the non-standard
	 *  `webkitdirectory` attribute (absent from lib.dom TS types → imperative). */
	const setFolderInput = (el: HTMLInputElement | null) => {
		fileInputRef.current = el;
		if (el) el.setAttribute("webkitdirectory", "");
	};

	useEffect(() => {
		if (isOpen) void load();
		if (!isOpen) {
			setSelectedId(null);
			setPendingDelete(null);
			setIsImporting(false);
		}
	}, [isOpen, load]);

	const selected = entries.find((e) => e.id === selectedId) ?? null;

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
			const ids = await importTree(Array.from(files));
			toast.success(t("coauthor.skill.import_success", { n: ids.length, ids: ids.join(", ") }));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("coauthor.skill.import_failed"));
		} finally {
			setIsImporting(false);
			// Reset so picking the same folder again fires `change`.
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	/** Reference guard: resolve which modules still bind this skill before
	 *  deleting, then open a confirm that names them. */
	const handleDelete = async (skill: SkillCatalogEntryDto) => {
		try {
			const modules = await listCoauthorModulesAction();
			const referencedBy = modules
				.filter((m) => m.skillIds.includes(skill.id))
				.map((m) => m.name);
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
			await remove(id);
			if (selectedId === id) setSelectedId(null);
			toast.success(t("coauthor.skill.deleted"));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("coauthor.skill.delete_failed"));
		}
	};

	const close = () => setIsOpen(false);

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
				data-testid="skill-folder-input"
				onChange={(e) => { void handleFilesPicked(e.target.files); }}
			/>
			{pendingDelete && (
				<DestructiveConfirmModal
					title={t("coauthor.skill.delete_confirm_title")}
					body={
						pendingDelete.referencedBy.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								<span>{t("coauthor.skill.delete_referenced_body")}</span>
								<div className="flex flex-wrap justify-center gap-1.5">
									{pendingDelete.referencedBy.map((name) => (
										<span key={name} className="rounded-full border border-danger/40 bg-danger-dim px-2 py-0.5 font-ui text-[11px] text-danger-text">{name}</span>
									))}
								</div>
								<span className="text-t4">{t("coauthor.skill.delete_referenced_hint")}</span>
							</div>
						) : (
							<>{t("coauthor.skill.delete_confirm_body")}</>
						)
					}
					confirmLabel={t("coauthor.skill.delete")}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
			<MasterDetailModal
				isOpen={isOpen}
				onClose={close}
				title={t("coauthor.skill.title")}
				subtitle={t("coauthor.skill.subtitle")}
				headerActions={
					<button
						type="button"
						data-testid="skill-import-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1 disabled:opacity-40 disabled:cursor-not-allowed"
						disabled={isImporting}
						onClick={handleImportClick}
					>
						<Icons.Import className="h-3.5 w-3.5" />
						{isImporting ? t("coauthor.skill.importing") : t("coauthor.skill.import")}
					</button>
				}
				containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[680px] w-[860px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
				masterClassName="flex w-[260px] shrink-0 flex-col border-r border-border"
				masterContent={({ openDetail }) => (
					<SkillList
						entries={entries}
						isLoading={isLoading}
						hasLoaded={hasLoaded}
						selectedId={selectedId}
						t={t}
						onSelect={(id) => handleSelect(id, openDetail)}
						onDelete={(skill) => { void handleDelete(skill); }}
					/>
				)}
				detailContent={({ closeDetail }) =>
					selected ? (
						<SkillDetail
							skill={selected}
							t={t}
							onDelete={() => { void handleDelete(selected); }}
							closeDetail={closeDetail}
						/>
					) : (
						<div className="font-ui text-[13px] text-t3">{t("coauthor.skill.empty_detail")}</div>
					)
				}
				footer={
					<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3">
						<button
							type="button"
							className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1"
							onClick={close}
						>
							{t("coauthor.skill.close")}
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
	t: TFunc;
	onSelect: (id: string) => void;
	onDelete: (skill: SkillCatalogEntryDto) => void;
}

function SkillList({ entries, isLoading, hasLoaded, selectedId, t, onSelect, onDelete }: SkillListProps) {
	if (isLoading && !hasLoaded) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t("coauthor.skill.loading")}</div>;
	}
	return (
		<div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
			<div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
				{t("coauthor.skill.list_label")}
			</div>
			<div className="flex-1 overflow-y-auto">
				{entries.length === 0 ? (
					<div className="flex h-full items-center justify-center px-2">
						<EmptyState
							icon={<Icons.Book />}
							title={t("coauthor.skill.empty")}
							sub={t("coauthor.skill.empty_sub")}
						/>
					</div>
				) : (
					entries.map((skill) => {
						const isSelected = skill.id === selectedId;
						const isUser = skill.source === "user";
						return (
							<div
								key={`${skill.source}:${skill.id}`}
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
											<span className="shrink-0 rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t("coauthor.skill.shadow_title")}>
												{t("coauthor.skill.shadow")}
											</span>
										)}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px] text-t4">{skill.id}</div>
								</div>
								{isUser && (
									<div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											data-testid={`skill-delete-btn-${skill.id}`}
											className="flex h-6 w-6 items-center justify-center rounded text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text md:opacity-0 md:group-hover:opacity-100"
											title={t("coauthor.skill.delete")}
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
	t: TFunc;
	onDelete: () => void;
	closeDetail?: () => void;
}

function SkillDetail({ skill, t, onDelete }: SkillDetailProps) {
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{skill.name}</h3>
					{skill.source === "user" ? (
						<span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("coauthor.skill.user")}</span>
					) : (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("coauthor.skill.built_in")}</span>
					)}
					{skill.shadowsBuiltin && (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t("coauthor.skill.shadow_title")}>{t("coauthor.skill.shadow")}</span>
					)}
				</div>
				<p className="mt-1 font-ui text-[13px] leading-relaxed text-t2">{skill.description}</p>
			</div>

			{skill.source === "user" && (
				<button
					type="button"
					data-testid="skill-detail-delete-btn"
					className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t3 transition-colors hover:border-danger hover:text-danger-text"
					onClick={onDelete}
				>
					<Icons.Trash className="h-3 w-3" />
					{t("coauthor.skill.delete")}
				</button>
			)}

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("coauthor.skill.id_label")}>
					<span className="font-mono text-[12px] text-t1">{skill.id}</span>
				</PreviewRow>
				<PreviewRow label={t("coauthor.skill.manifest_label")}>
					<span className="font-mono text-[11px] break-all text-t2">{skill.manifestPath}</span>
				</PreviewRow>
				<PreviewRow label={t("coauthor.skill.source_label")}>
					<span className="font-ui text-[12px] text-t2">
						{skill.source === "user" ? t("coauthor.skill.user") : t("coauthor.skill.built_in")}
						{skill.shadowsBuiltin && ` · ${t("coauthor.skill.shadow")}`}
					</span>
				</PreviewRow>
			</dl>

			<p className="font-ui text-[11px] leading-relaxed text-t3">{t("coauthor.skill.inspect_hint")}</p>
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
