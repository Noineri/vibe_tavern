import { useEffect, useRef, useState } from "react";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../../../shared/MasterDetailModal.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { Icons } from "../../../shared/icons.js";
import { useCopilotSkillStore } from "../../../../stores/copilot-skill-store.js";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../../../lib/cn.js";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";

/**
 * Copilot skill library manager (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 /
 * CP-10). Mirrors `CoauthorSkillModal` against the copilot skill roots: lists
 * the merged metadata-only catalog (built-in + user, user shadows builtin),
 * imports a skill tree via a folder upload, inspects metadata, and deletes user
 * skills. Built-in skills are read-only (the server rejects their delete).
 *
 * CONTROLLED — unlike `CoauthorSkillModal` (which keys off the global
 * `modal-store`), this modal is owned by `CopilotProfileModal` (opened from its
 * "Manage skills" action), so open/close are props.
 */
export interface CopilotSkillModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CopilotSkillModal({ isOpen, onClose }: CopilotSkillModalProps) {
	const { t } = useT();

	const entries = useCopilotSkillStore((s) => s.entries);
	const isLoading = useCopilotSkillStore((s) => s.isLoading);
	const hasLoaded = useCopilotSkillStore((s) => s.hasLoaded);
	const load = useCopilotSkillStore((s) => s.load);
	const importTree = useCopilotSkillStore((s) => s.importTree);
	const remove = useCopilotSkillStore((s) => s.remove);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isImporting, setIsImporting] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
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
			toast.success(t("copilot_skill_import_success", { n: ids.length, ids: ids.join(", ") }));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("copilot_skill_import_failed"));
		} finally {
			setIsImporting(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const handleConfirmDelete = async () => {
		const id = pendingDelete;
		setPendingDelete(null);
		if (!id) return;
		try {
			await remove(id);
			if (selectedId === id) setSelectedId(null);
			toast.success(t("copilot_skill_deleted"));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("copilot_skill_delete_failed"));
		}
	};

	return (
		<>
			<input
				ref={setFolderInput}
				type="file"
				multiple
				className="hidden"
				data-testid="copilot-skill-folder-input"
				onChange={(e) => { void handleFilesPicked(e.target.files); }}
			/>
			{pendingDelete && (
				<DestructiveConfirmModal
					title={t("copilot_skill_delete_confirm_title")}
					body={<>{t("copilot_skill_delete_confirm_body")}</>}
					confirmLabel={t("copilot_skill_delete")}
					onConfirm={() => { void handleConfirmDelete(); }}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
			<MasterDetailModal
				isOpen={isOpen}
				onClose={onClose}
				title={t("copilot_skill_title")}
				subtitle={t("copilot_skill_subtitle")}
				headerActions={
					<button
						type="button"
						data-testid="copilot-skill-import-btn"
						className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:text-t1 disabled:opacity-40 disabled:cursor-not-allowed"
						disabled={isImporting}
						onClick={handleImportClick}
					>
						<Icons.Import className="h-3.5 w-3.5" />
						{isImporting ? t("copilot_skill_importing") : t("copilot_skill_import")}
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
						onDelete={(id) => setPendingDelete(id)}
					/>
				)}
				detailContent={() =>
					selected ? (
						<SkillDetail skill={selected} t={t} onDelete={() => setPendingDelete(selected.id)} />
					) : (
						<div className="font-ui text-[13px] text-t3">{t("copilot_skill_empty_detail")}</div>
					)
				}
				footer={
					<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3">
						<button
							type="button"
							className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1"
							onClick={onClose}
						>
							{t("copilot_skill_close")}
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
	onDelete: (id: string) => void;
}

function SkillList({ entries, isLoading, hasLoaded, selectedId, t, onSelect, onDelete }: SkillListProps) {
	if (isLoading && !hasLoaded) {
		return <div className="p-4 font-ui text-[13px] text-t3">{t("copilot_skill_loading")}</div>;
	}
	return (
		<div className="flex flex-col flex-1 min-h-0 pt-5 pb-2.5">
			<div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">
				{t("copilot_skill_list_label")}
			</div>
			<div className="flex-1 overflow-y-auto">
				{entries.length === 0 ? (
					<div className="flex h-full items-center justify-center px-2">
						<EmptyState
							icon={<Icons.Book />}
							title={t("copilot_skill_empty")}
							sub={t("copilot_skill_empty_sub")}
						/>
					</div>
				) : (
					entries.map((skill) => {
						const isSelected = skill.id === selectedId;
						const isUser = skill.source === "user";
						return (
							<div
								key={`${skill.source}:${skill.id}`}
								data-testid={`copilot-skill-row-${skill.id}`}
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
											<span className="shrink-0 rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t("copilot_skill_shadow_title")}>
												{t("copilot_skill_shadow")}
											</span>
										)}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px] text-t4">{skill.id}</div>
								</div>
								{isUser && (
									<div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											data-testid={`copilot-skill-delete-btn-${skill.id}`}
											className="flex h-6 w-6 items-center justify-center rounded text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text md:opacity-0 md:group-hover:opacity-100"
											title={t("copilot_skill_delete")}
											onClick={() => onDelete(skill.id)}
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
}

function SkillDetail({ skill, t, onDelete }: SkillDetailProps) {
	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-body text-[17px] font-semibold text-t1">{skill.name}</h3>
					{skill.source === "user" ? (
						<span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("copilot_skill_user")}</span>
					) : (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3">{t("copilot_skill_built_in")}</span>
					)}
					{skill.shadowsBuiltin && (
						<span className="rounded-full bg-s3 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-t3" title={t("copilot_skill_shadow_title")}>{t("copilot_skill_shadow")}</span>
					)}
				</div>
				<p className="mt-1 font-ui text-[13px] leading-relaxed text-t2">{skill.description}</p>
			</div>

			{skill.source === "user" && (
				<button
					type="button"
					data-testid="copilot-skill-detail-delete-btn"
					className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 font-ui text-[12px] text-t3 transition-colors hover:border-danger hover:text-danger-text"
					onClick={onDelete}
				>
					<Icons.Trash className="h-3 w-3" />
					{t("copilot_skill_delete")}
				</button>
			)}

			<dl className="flex flex-col gap-3">
				<PreviewRow label={t("copilot_skill_id_label")}>
					<span className="font-mono text-[12px] text-t1">{skill.id}</span>
				</PreviewRow>
				<PreviewRow label={t("copilot_skill_manifest_label")}>
					<span className="font-mono text-[11px] break-all text-t2">{skill.manifestPath}</span>
				</PreviewRow>
				<PreviewRow label={t("copilot_skill_source_label")}>
					<span className="font-ui text-[12px] text-t2">
						{skill.source === "user" ? t("copilot_skill_user") : t("copilot_skill_built_in")}
						{skill.shadowsBuiltin && ` · ${t("copilot_skill_shadow")}`}
					</span>
				</PreviewRow>
			</dl>

			<p className="font-ui text-[11px] leading-relaxed text-t3">{t("copilot_skill_inspect_hint")}</p>
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
