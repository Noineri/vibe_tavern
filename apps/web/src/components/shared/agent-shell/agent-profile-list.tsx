import { arrayMove } from "@dnd-kit/sortable";
import { MasterList } from "../master-list/master-list.js";
import { MasterListTag } from "../master-list/master-list-tag.js";
import { MasterListPhoneRow, SortableMasterListPhoneRow } from "../master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../master-list/master-list-overlay-row.js";
import { EmptyState } from "../empty-state.js";
import { Icons } from "../icons.js";
import { cn } from "../../../lib/cn.js";
import { listHeaderCls } from "../../../lib/field-tokens.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import type { TFunc } from "../../../i18n/context.js";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import { builtinProfileDisplayName } from "../../../lib/agent-builtin-profiles.js";
import { BUILTIN_PROFILE_ID } from "./use-agent-profile-assignment.js";

/**
 * The profiles modal master list — extracted from `AgentProfileModal.tsx`
 * at the file-size ratchet (DR-8; a pure move). Mirrors the
 * `ProviderModal` + `ProviderProfileList` exemplar: the MODAL owns the
 * master-detail shell + editor + footer, this module the list surface
 * (data + slots only — the row anatomy lives in `shared/master-list`).
 */
export type DetailMode = "view" | "edit" | "create";

export interface ProfileListProps {
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
	/** The kind under management — the reorder persist passes THIS kind
	 *  (ML-6: order is within one kind's list). The modal already knows it
	 *  as a prop; the list must not reorder another kind's profiles. */
	agentKind: string;
	onSelect: (id: string) => void;
	onAdd: () => void;
}

export function ProfileList({ profiles, isLoading, selectedId, activeProfileId, defaultProfileId, detailMode, t, agentKind, onSelect, onAdd }: ProfileListProps) {
	const reorderProfiles = useCopilotProfileStore((s) => s.reorder);
	if (isLoading) {
		return <div className="p-4 font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("copilot_profile_loading")}</div>;
	}
	return (
		<MasterList<CopilotProfile>
			items={profiles}
			getId={(p) => p.id}
			// The pinned built-in seed is never sortable (ML-3 pattern).
			sortableIds={profiles.filter((p) => p.id !== BUILTIN_PROFILE_ID).map((p) => p.id)}
			onReorderItems={(activeId, overId, currentItems) => {
				// The built-in seed has no stored record: dragging onto it
				// is a noop (the ML-3 ServicePromptsPane Default guard).
				if (activeId === BUILTIN_PROFILE_ID || overId === BUILTIN_PROFILE_ID) {
					return { optimisticItems: currentItems, persist: () => {} };
				}
				const fromIdx = currentItems.findIndex((p) => p.id === activeId);
				const toIdx = currentItems.findIndex((p) => p.id === overId);
				if (fromIdx === -1 || toIdx === -1) {
					return { optimisticItems: currentItems, persist: () => {} };
				}
				const reordered = arrayMove(currentItems, fromIdx, toIdx);
				return {
					optimisticItems: reordered,
					persist: () => reorderProfiles(agentKind, reordered.filter((p) => !p.isBuiltIn).map((p, i) => ({ id: p.id, sortOrder: i }))),
				};
			}}
			header={(
				<div className={cn(listHeaderCls, "mb-1.5 px-4")}>
					{t("copilot_profile_list_label")}
				</div>
			)}
			emptyState={profiles.length === 0 ? (
				<div className="flex h-full items-center justify-center px-2">
					<EmptyState
						icon={<Icons.Tool />}
						title={t("copilot_profile_empty")}
						sub={t("copilot_profile_empty_sub")}
					/>
				</div>
			) : undefined}
			renderRow={(p) => {
				const isActive = p.id === activeProfileId;
				const isSelected = (p.id === selectedId && detailMode === "view") || (detailMode === "edit" && p.id === selectedId);
				// The kind-default pill (chat-target hosts only): the
				// null default reads as the built-in seed, mirroring
				// the script null→builtin fallback.
				const showDefaultPill = defaultProfileId !== undefined && p.id === (defaultProfileId ?? BUILTIN_PROFILE_ID);
				// SC-16d: the name owns line 1 alone (wraps, never cut); the pills
				// own the primitive's tags line below it (ML-12: the shared
				// `MasterListTag` shape, no id line). Each pill keeps the row's
				// pills testid on its wrapper — a chat-default seed row holds two.
				const title = (
					<span
						data-testid={`copilot-profile-row-name-${p.id}`}
						className="whitespace-normal break-words"
					>
						{builtinProfileDisplayName(p.id, agentKind, p.name, t)}
					</span>
				);
				const tags = (p.isBuiltIn || showDefaultPill) ? (
					<>
						{p.isBuiltIn && (
							<span data-testid={`copilot-profile-row-pills-${p.id}`}>
								<MasterListTag>{t("copilot_profile_built_in")}</MasterListTag>
							</span>
						)}
						{showDefaultPill && (
							<span data-testid={`copilot-profile-row-pills-${p.id}`}>
								<MasterListTag>{t("copilot_profile_default")}</MasterListTag>
							</span>
						)}
					</>
				) : undefined;
				if (p.id === BUILTIN_PROFILE_ID) {
					return (
						<MasterListPhoneRow
							rowTestId={`copilot-profile-row-${p.id}`}
							selected={isSelected}
							active={isActive}
							title={title}
							tags={tags}
							onSelect={() => onSelect(p.id)}
						/>
					);
				}
				return (
					<SortableMasterListPhoneRow
						sortableId={p.id}
						rowTestId={`copilot-profile-row-${p.id}`}
						selected={isSelected}
						active={isActive}
						title={title}
						tags={tags}
						onSelect={() => onSelect(p.id)}
					/>
				);
			}}
			renderOverlayRow={(item) => (
				<MasterListDragOverlayRow active={item.id === activeProfileId} title={builtinProfileDisplayName(item.id, agentKind, item.name, t)} />
			)}
			footer={(
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
			)}
		/>
	);
}

