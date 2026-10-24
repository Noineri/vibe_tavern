import { arrayMove } from "@dnd-kit/sortable";
import { MasterList } from "../shared/master-list/master-list.js";
import { SortableMasterListPhoneRow } from "../shared/master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../shared/master-list/master-list-overlay-row.js";
import { reorderCoauthorModules } from "../../api/coauthor-module-api.js";
import { EmptyState } from "../shared/empty-state.js";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { listHeaderCls } from "../../lib/field-tokens.js";
import type { TFunc } from "../../i18n/context.js";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import type { DetailMode } from "./CoauthorModuleModal.js";

export interface ModuleListProps {
	modules: CoauthorModule[];
	isLoading: boolean;
	selectedId: string | null;
	activeModuleId: string;
	detailMode: DetailMode;
	t: TFunc;
	onSelect: (id: string) => void;
	onAdd: () => void;
	/** Adopt the server-persisted order after a drag (the reorder response
	 *  is the refreshed merged list — the ProxyManagerModal pattern). */
	onPersistOrder: (modules: CoauthorModule[]) => void;
}

// Row anatomy lives in `shared/master-list` (handle, status slot, wrapping
// title, overlay, phone drill-down row). This list supplies data + slots:
// the name (SC-16d: wraps, never cut) + built-in tag in the title slot, the
// description in the second line, the active dot for the live module in the status
// slot (the row rules: «in use» is a marker, never a whole-row color), and
// the arrayMove + reorderCoauthorModules persist (the ML-5 backend — the
// response is the refreshed merged list, adopted via `onPersistOrder`).
export function ModuleList({ modules, isLoading, selectedId, activeModuleId, detailMode, t, onSelect, onAdd, onPersistOrder }: ModuleListProps) {
	if (isLoading) {
		return <div className="p-4 font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("coauthor.module.loading")}</div>;
	}
	return (
		<MasterList<CoauthorModule>
			items={modules}
			getId={(m) => m.id}
			onReorderItems={(activeId, overId, currentItems) => {
				const fromIdx = currentItems.findIndex((m) => m.id === activeId);
				const toIdx = currentItems.findIndex((m) => m.id === overId);
				if (fromIdx === -1 || toIdx === -1) {
					return { optimisticItems: currentItems, persist: () => {} };
				}
				const reordered = arrayMove(currentItems, fromIdx, toIdx);
				return {
					optimisticItems: reordered,
					persist: () => reorderCoauthorModules(reordered.map((m, i) => ({ id: m.id, sortOrder: i }))).then((refreshed) => { onPersistOrder(refreshed); }),
				};
			}}
			header={(
				<div className={cn(listHeaderCls, "mb-1.5 px-4")}>
					{t("coauthor.module.list_label")}
				</div>
			)}
			emptyState={modules.length === 0 ? (
				<div className="flex h-full items-center justify-center px-2">
					<EmptyState
						icon={<Icons.Tool />}
						title={t("coauthor.module.empty")}
						sub={t("coauthor.module.empty_sub")}
					/>
				</div>
				) : undefined}
			renderRow={(m) => {
					const isActive = m.id === activeModuleId;
					const isSelected = (m.id === selectedId && detailMode === "view") || (detailMode === "edit" && m.id === selectedId);
					return (
						<SortableMasterListPhoneRow
							sortableId={m.id}
							rowTestId={`module-row-${m.id}`}
							selected={isSelected}
							active={isActive}
							title={(
								<>
									<span
										data-testid={`module-row-name-${m.id}`}
										className="whitespace-normal break-words"
									>
										{m.name}
									</span>
									{m.isBuiltIn && (
										<div data-testid={`module-row-pills-${m.id}`} className="mt-1 flex flex-wrap gap-1">
											<span className="shrink-0 rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
												{t("coauthor.module.built_in")}
											</span>
										</div>
									)}
								</>
							)}
							secondLine={m.description ? <span className="line-clamp-2 leading-snug">{m.description}</span> : undefined}
							onSelect={() => onSelect(m.id)}
						/>
					);
				}}
				renderOverlayRow={(m) => (
					<MasterListDragOverlayRow active={m.id === activeModuleId} title={m.name} />
				)}
				footer={(
					<div className="shrink-0 border-t border-border px-3 pt-3">
						<button
							type="button"
							data-testid="module-new-btn"
							className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
							onClick={() => onAdd()}
						>
							<Icons.Plus /> {t("coauthor.module.new")}
						</button>
					</div>
				)}
			/>
	);
}
