import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { toast } from "sonner";
import {
	SERVICE_PROMPT_FIELD_FAMILIES,
	SERVICE_PROMPT_FIELD_KEYS,
	SERVICE_PROMPT_FIELDS,
	type ServicePromptFieldFamily,
	type ServicePromptFieldKey,
} from "@vibe-tavern/domain";
import type { ServicePromptProfile, ServicePromptProfileDetailResponse } from "@vibe-tavern/api-contracts";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { MasterDetailFooter } from "../../shared/MasterDetailModal.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { monoCls, lblCls } from "../../build/fields/field-styles.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	createServicePromptProfile,
	deleteServicePromptProfile,
	getServicePromptProfileDetail,
	listServicePromptProfiles,
	reorderServicePromptProfiles,
	setActiveServicePromptProfile,
	updateServicePromptProfile,
} from "../../../api/service-prompt-api.js";

export interface ServicePromptsPaneSlots {
	master: ReactNode;
	detail: ReactNode;
	footer: ReactNode;
	dirty: boolean;
}

type FieldOverrides = Partial<Record<ServicePromptFieldKey, string>>;

const FAMILY_ORDER: readonly ServicePromptFieldFamily[] = Object.values(SERVICE_PROMPT_FIELD_FAMILIES);

const FAMILY_LABEL_KEYS: Record<ServicePromptFieldFamily, string> = {
	[SERVICE_PROMPT_FIELD_FAMILIES.assistant]: "promptManager.servicePrompts.family.assistant",
	[SERVICE_PROMPT_FIELD_FAMILIES.summary]: "promptManager.servicePrompts.family.summary",
	[SERVICE_PROMPT_FIELD_FAMILIES.insights]: "promptManager.servicePrompts.family.insights",
	[SERVICE_PROMPT_FIELD_FAMILIES.bases]: "promptManager.servicePrompts.family.bases",
};

const FIELD_LABEL_KEYS: Partial<Record<ServicePromptFieldKey, string>> = {
	script: "ai_assistant_mode_script",
	dice_script: "promptManager.servicePrompts.field.dice_script",
	lore_entry: "ai_assistant_mode_lore_entry",
	lore_keys: "ai_assistant_mode_lore_keys",
	chat_impersonate: "ai_assistant_mode_chat_impersonate",
	md_import: "promptManager.servicePrompts.field.md_import",
	vision_describe: "ai_assistant_mode_vision_describe",
	scene_schema: "ai_assistant_mode_scene_schema",
	scene_rules: "promptManager.servicePrompts.field.scene_rules",
	message_edit: "ai_assistant_mode_message_edit",
	message_merge: "ai_assistant_mode_message_merge",
	regex: "promptManager.servicePrompts.field.regex",
	summary: "promptManager.servicePrompts.field.summary",
	objective_generate: "promptManager.servicePrompts.field.objective_generate",
	objective_generate_goals: "promptManager.servicePrompts.field.objective_generate_goals",
	objective_check: "promptManager.servicePrompts.field.objective_check",
	scene_generate: "promptManager.servicePrompts.field.scene_generate",
	coauthor_base: "promptManager.servicePrompts.field.coauthor_base",
	copilot_base: "promptManager.servicePrompts.field.copilot_base",
	copilot_user_flow: "promptManager.servicePrompts.field.copilot_user_flow",
	interactive_rules: "promptManager.servicePrompts.field.interactive_rules",
	interactive_visual: "promptManager.servicePrompts.field.interactive_visual",
};

function truncateForPlaceholder(value: string): string {
	if (value.length <= 120) return value;
	return `${value.slice(0, 120)}…`;
}

function overridesEqual(a: FieldOverrides, b: FieldOverrides): boolean {
	for (const key of SERVICE_PROMPT_FIELD_KEYS) {
		if ((a[key] ?? "") !== (b[key] ?? "")) return false;
	}
	return true;
}

const SortableServiceRow = React.memo(
	({
		profile,
		isActive,
		isSelected,
		onSelect,
		isMobile,
		onRenameStart,
		renderDrillDown,
	}: {
		profile: ServicePromptProfile;
		isActive: boolean;
		isSelected: boolean;
		onSelect: (id: string) => void;
		isMobile: boolean;
		onRenameStart: (id: string, name: string) => void;
		renderDrillDown?: (id: string, selectRow: () => void) => ReactNode;
	}) => {
		const { t } = useT();
		const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
			id: profile.id,
		});
		const style: CSSProperties = {
			transform: CSS.Translate.toString(transform),
			transition,
			...(isDragging ? { opacity: 0 } : {}),
		};
		return (
			<div
				ref={setNodeRef}
				style={style}
				onClick={() => onSelect(profile.id)}
				data-testid={"service-row-" + profile.id}
				className={cn(
					"group flex cursor-pointer items-center gap-2 border-l-2 min-h-[48px] px-3 sm:transition-colors touch-manipulation",
					isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
				)}
			>
				<button
					type="button"
					ref={setActivatorNodeRef}
					{...attributes}
					{...listeners}
					aria-label="drag"
					onClick={(e) => e.stopPropagation()}
					className="flex h-8 w-7 shrink-0 select-none items-center justify-center rounded cursor-grab touch-none text-t4 transition-colors hover:bg-s2 hover:text-t1 active:cursor-grabbing sm:h-auto sm:w-5"
				>
					<span className="text-base leading-none">≡</span>
				</button>
				<span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isActive ? "bg-accent" : "bg-transparent")} />
				{profile.isDefault && (
					<CustomTooltip content="promptManager.servicePrompts.liveTooltip">
						<span className="flex shrink-0 text-t3">
							<Icons.Lock />
						</span>
					</CustomTooltip>
				)}
				<CustomTooltip content={profile.name}>
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-ui text-[13px] font-medium",
							isSelected ? "text-accent-t" : "text-t2",
						)}
					>
						{profile.name}
					</span>
				</CustomTooltip>
				<button
					type="button"
					aria-label={t("edit")}
					onClick={(e) => {
						e.stopPropagation();
						onRenameStart(profile.id, profile.name);
					}}
					className={cn(
						"shrink-0 rounded p-1 transition-colors",
						isMobile ? "text-t4" : "opacity-0 group-hover:opacity-100 text-t4 hover:bg-s3 hover:text-t1",
						isMobile && "ml-1",
					)}
				>
					<Icons.Edit />
				</button>
				{!isMobile && (
					<div className="ml-auto hidden md:flex">
						{renderDrillDown?.(profile.id, () => onSelect(profile.id))}
					</div>
				)}
				{isMobile && renderDrillDown?.(profile.id, () => onSelect(profile.id))}
			</div>
		);
	},
);

export function ServicePromptsPane({
	active,
	children,
	renderRowDrillDown,
	onDirtyChange,
	onClose,
}: {
	active: boolean;
	children: (slots: ServicePromptsPaneSlots) => ReactNode;
	renderRowDrillDown?: (profileId: string, selectRow: () => void) => ReactNode;
	onDirtyChange?: (dirty: boolean) => void;
	onClose?: () => void;
}): ReactNode {
	const { t, tDynamic } = useT();
	const isMobile = useIsMobile();
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [profiles, setProfiles] = useState<ServicePromptProfile[]>([]);
	const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailNonce, setDetailNonce] = useState(0);
	const [detail, setDetail] = useState<ServicePromptProfileDetailResponse | null>(null);
	const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [detailErrorKey, setDetailErrorKey] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const [draftOverrides, setDraftOverrides] = useState<FieldOverrides>({});
	const [saving, setSaving] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [expandedFamilies, setExpandedFamilies] = useState<Record<string, boolean>>(() => {
		const init: Record<string, boolean> = {};
		for (const f of FAMILY_ORDER) init[f] = false;
		return init;
	});
	const renameInputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (renamingId) renameInputRef.current?.focus();
	}, [renamingId]);
	useEffect(() => {
		if (isCreating) newInputRef.current?.focus();
	}, [isCreating]);

	const isDefaultSelected = detail?.profile.isDefault ?? false;

	const dirty = useMemo(() => {
		if (!detail) return false;
		if (draftName !== detail.profile.name) return true;
		return !overridesEqual(draftOverrides, detail.profile.overrides);
	}, [detail, draftName, draftOverrides]);

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);

	const defaultProfile = useMemo(() => profiles.find((p) => p.isDefault) ?? null, [profiles]);
	const nonDefaultProfiles = useMemo(() => profiles.filter((p) => !p.isDefault), [profiles]);

	const {
		displayItems: displayNonDefault,
		sensors,
		activeDragItem,
		handleDragStart,
		handleDragEnd,
		handleDragCancel,
	} = useReorderableList<ServicePromptProfile>({
		items: nonDefaultProfiles,
		getId: (p) => p.id,
		onReorder: (activeId, overId, currentItems) => {
			const fromIdx = currentItems.findIndex((p) => p.id === activeId);
			const toIdx = currentItems.findIndex((p) => p.id === overId);
			if (fromIdx === -1 || toIdx === -1) {
				return { optimisticItems: currentItems, persist: () => {} };
			}
			const reordered = arrayMove(currentItems, fromIdx, toIdx);
			return {
				optimisticItems: reordered,
				persist: () => reorderServicePromptProfiles(reordered.map((p, i) => ({ id: p.id, sortOrder: i }))).then((res) => {
					setProfiles(res.profiles);
					setActiveProfileId(res.activeProfileId);
				}),
			};
		},
	});

	const orderedProfiles = useMemo(() => {
		return defaultProfile ? [defaultProfile, ...displayNonDefault] : [...displayNonDefault];
	}, [defaultProfile, displayNonDefault]);

	const refreshList = useCallback(async () => {
		setLoadState("loading");
		try {
			const res = await listServicePromptProfiles();
			setProfiles(res.profiles);
			setActiveProfileId(res.activeProfileId);
			setLoadState("ready");
			if (!selectedId && res.profiles.length > 0) {
				const liveId = res.activeProfileId ?? res.profiles.find((p) => p.isDefault)?.id ?? res.profiles[0]!.id;
				setSelectedId(liveId);
			}
		} catch {
			setLoadState("error");
		}
	}, [selectedId]);

	useEffect(() => {
		if (!active) return;
		if (loadState === "idle") {
			void refreshList();
		}
	}, [active, loadState, refreshList]);

	useEffect(() => {
		if (!active) return;
		if (!selectedId) return;
		setDetailState("loading");
		setDetailErrorKey(null);
		let cancelled = false;
		void getServicePromptProfileDetail(selectedId)
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					setDetailState("error");
					setDetailErrorKey("promptManager.servicePrompts.detailError");
					return;
				}
				setDetail(res);
				setDraftName(res.profile.name);
				setDraftOverrides({ ...res.profile.overrides });
				setDetailState("ready");
			})
			.catch(() => {
				if (cancelled) return;
				setDetailState("error");
				setDetailErrorKey("promptManager.servicePrompts.detailError");
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId, detailNonce]);

	const handleSetActive = useCallback(
		async (id: string, isDefault: boolean) => {
			const target = isDefault ? null : id;
			try {
				await setActiveServicePromptProfile(target);
				setActiveProfileId(target);
			} catch {
				toast.error(tDynamic("promptManager.servicePrompts.activateFailed"));
			}
		},
		[tDynamic],
	);

	const handleSelectRow = useCallback(
		(id: string) => {
			if (id === selectedId) {
				const p = profiles.find((pr) => pr.id === id);
				if (p) {
					const alreadyLive = (activeProfileId === null && p.isDefault) || activeProfileId === id;
					if (!alreadyLive) void handleSetActive(id, p.isDefault);
				}
				return;
			}
			if (dirty) {
				setPendingSelectId(id);
				return;
			}
			setSelectedId(id);
			const p = profiles.find((pr) => pr.id === id);
			if (p) void handleSetActive(id, p.isDefault);
		},
		[dirty, selectedId, profiles, activeProfileId, handleSetActive],
	);

	const confirmDiscard = useCallback(() => {
		if (pendingSelectId) {
			const id = pendingSelectId;
			setSelectedId(id);
			setPendingSelectId(null);
			const p = profiles.find((pr) => pr.id === id);
			if (p) void handleSetActive(id, p.isDefault);
		}
	}, [pendingSelectId, profiles, handleSetActive]);

	const handleRenameStart = useCallback((id: string, name: string) => {
		setRenamingId(id);
		setRenameValue(name);
	}, []);

	const handleRenameSave = useCallback(async () => {
		if (!renamingId) return;
		const trimmed = renameValue.trim();
		if (!trimmed) {
			setRenamingId(null);
			return;
		}
		try {
			const updated = await updateServicePromptProfile(renamingId, { name: trimmed });
			setProfiles((prev) => prev.map((p) => (p.id === renamingId ? { ...p, name: updated.name } : p)));
			if (detail && detail.profile.id === renamingId) {
				setDetail({ ...detail, profile: { ...detail.profile, name: updated.name } });
			}
		} catch {
			toast.error(tDynamic("promptManager.servicePrompts.renameFailed"));
		} finally {
			setRenamingId(null);
		}
	}, [renamingId, renameValue, detail, tDynamic]);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteServicePromptProfile(id);
				const wasSelected = selectedId === id;
				const res = await listServicePromptProfiles();
				setProfiles(res.profiles);
				setActiveProfileId(res.activeProfileId);
				setConfirmDeleteId(null);
				if (wasSelected) {
					const liveId = res.activeProfileId ?? res.profiles.find((p) => p.isDefault)?.id ?? res.profiles[0]?.id ?? null;
					setSelectedId(liveId);
				}
			} catch {
				setConfirmDeleteId(null);
				toast.error(tDynamic("promptManager.servicePrompts.deleteFailed"));
			}
		},
		[selectedId, tDynamic],
	);

	const handleDuplicate = useCallback(
		async (profile: ServicePromptProfile) => {
			try {
				const dup = await createServicePromptProfile({
					name: `${profile.name} (copy)`,
					overrides: { ...profile.overrides },
				});
				const res = await listServicePromptProfiles();
				setProfiles(res.profiles);
				setActiveProfileId(dup.id);
				await setActiveServicePromptProfile(dup.id);
				setActiveProfileId(dup.id);
				setSelectedId(dup.id);
				setRenamingId(dup.id);
				setRenameValue(dup.name);
			} catch {
				toast.error(tDynamic("promptManager.servicePrompts.duplicateFailed"));
			}
		},
		[tDynamic],
	);

	const handleCreateNew = useCallback(async () => {
		const name = newName.trim() || tDynamic("promptManager.servicePrompts.newProfileDefault");
		try {
			const created = await createServicePromptProfile({ name, overrides: {} });
			const res = await listServicePromptProfiles();
			setProfiles(res.profiles);
			await setActiveServicePromptProfile(created.id);
			setActiveProfileId(created.id);
			setSelectedId(created.id);
			setIsCreating(false);
			setNewName("");
			setRenamingId(created.id);
			setRenameValue(created.name);
		} catch {
			setIsCreating(false);
			toast.error(tDynamic("promptManager.servicePrompts.createFailed"));
		}
	}, [newName, tDynamic]);

	const handleSave = useCallback(async () => {
		if (!detail || isDefaultSelected) return;
		setSaving(true);
		try {
			const updated = await updateServicePromptProfile(detail.profile.id, {
				name: draftName.trim() || detail.profile.name,
				overrides: draftOverrides,
			});
			setProfiles((prev) => prev.map((p) => (p.id === updated.id ? { ...p, name: updated.name } : p)));
			setDetail({ profile: updated, resolved: detail.resolved });
		} catch {
			toast.error(tDynamic("promptManager.servicePrompts.saveFailed"));
		} finally {
			setSaving(false);
		}
	}, [detail, draftName, draftOverrides, isDefaultSelected, tDynamic]);

	const handleResetField = useCallback((field: ServicePromptFieldKey) => {
		setDraftOverrides((prev) => {
			const next = { ...prev };
			delete next[field];
			return next;
		});
	}, []);

	const handleFieldChange = useCallback((field: ServicePromptFieldKey, value: string) => {
		setDraftOverrides((prev) => ({ ...prev, [field]: value }));
	}, []);

	const toggleFamily = useCallback((family: ServicePromptFieldFamily) => {
		setExpandedFamilies((prev) => ({ ...prev, [family]: !prev[family] }));
	}, []);

	const footerActions = useMemo(() => {
		if (!detail) return [];
		if (isDefaultSelected) {
			return [{ icon: <Icons.Copy />, label: t("promptManager.servicePrompts.duplicateButton"), onClick: () => void handleDuplicate(detail.profile) }];
		}
		return [
			{ icon: <Icons.Copy />, label: t("promptManager.servicePrompts.duplicateButton"), onClick: () => void handleDuplicate(detail.profile) },
			{ icon: <Icons.Trash />, label: t("delete"), onClick: () => setConfirmDeleteId(detail.profile.id) },
		];
	}, [detail, isDefaultSelected, t, handleDuplicate]);

	if (!active) {
		return children({ master: null, detail: null, footer: null, dirty: false });
	}

	const master = (
		<div className="flex flex-1 flex-col min-h-0 py-2.5">
			<div className="shrink-0 px-[13px]">
				<div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3 pb-[5px] pt-1">
					{t("promptManager.servicePrompts.masterTitle")}
				</div>
			</div>
			{loadState === "loading" && (
				<div className="px-4 py-6 font-ui text-[13px] text-t3">{t("loading")}</div>
			)}
			{loadState === "error" && (
				<div className="px-4 py-4">
					<div className="font-ui text-[13px] text-danger">{t("promptManager.servicePrompts.loadError")}</div>
					<button
						type="button"
						onClick={() => void refreshList()}
						className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[12px] text-t2 hover:bg-s3"
					>
						{t("retry")}
					</button>
				</div>
			)}
			{loadState === "ready" && (
				<div className="flex-1 overflow-y-auto">
					{defaultProfile && (() => {
						const p = defaultProfile;
						const isSelected = selectedId === p.id;
						const isActive = activeProfileId === null;
						const isRenaming = renamingId === p.id;
						return (
							<div
								key={p.id}
								data-testid={"service-row-" + p.id}
								onClick={() => handleSelectRow(p.id)}
								className={cn(
									"group flex cursor-pointer items-center gap-2 border-l-2 min-h-[48px] px-3 sm:transition-colors",
									isSelected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2",
								)}
							>
								<span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isActive ? "bg-accent" : "bg-transparent")} />
								<CustomTooltip content={t("promptManager.servicePrompts.liveTooltip")}>
									<span className="flex shrink-0 text-t3">
										<Icons.Lock />
									</span>
								</CustomTooltip>
								{isRenaming ? (
									<input
										ref={renameInputRef}
										value={renameValue}
										onChange={(e) => setRenameValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void handleRenameSave();
											if (e.key === "Escape") setRenamingId(null);
										}}
										onBlur={() => void handleRenameSave()}
										onClick={(e) => e.stopPropagation()}
										className="min-w-0 flex-1 rounded border border-accent bg-surface px-2 py-1 font-ui text-[13px] text-t1 outline-none"
									/>
								) : (
									<CustomTooltip content={p.name}>
										<span
											className={cn(
												"min-w-0 flex-1 truncate font-ui text-[13px] font-medium",
												isSelected ? "text-accent-t" : "text-t2",
											)}
										>
											{p.name}
											<span className="ml-1.5 rounded bg-success/15 px-1 py-0.5 font-ui text-[10px] text-success">
												{t("promptManager.servicePrompts.liveBadge")}
											</span>
										</span>
									</CustomTooltip>
								)}
								{!isRenaming && (
									<button
										type="button"
										aria-label={t("edit")}
										onClick={(e) => {
											e.stopPropagation();
											handleRenameStart(p.id, p.name);
										}}
										className={cn(
											"shrink-0 rounded p-1 transition-colors",
											isMobile ? "text-t4" : "opacity-0 group-hover:opacity-100 text-t4 hover:bg-s3 hover:text-t1",
										)}
									>
										<Icons.Edit />
									</button>
								)}
								{renderRowDrillDown?.(p.id, () => handleSelectRow(p.id))}
							</div>
						);
					})()}
					<DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
						<SortableContext items={displayNonDefault.map((p) => p.id)} strategy={verticalListSortingStrategy}>
							{displayNonDefault.map((p) => {
								const isSelected = selectedId === p.id;
								const isActive = activeProfileId === p.id;
								const isRenaming = renamingId === p.id;
								if (isRenaming) {
									return (
										<div key={p.id} className="border-l-2 border-transparent px-3 py-2">
											<input
												ref={renameInputRef}
												value={renameValue}
												onChange={(e) => setRenameValue(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") void handleRenameSave();
													if (e.key === "Escape") setRenamingId(null);
												}}
												onBlur={() => void handleRenameSave()}
												onClick={(e) => e.stopPropagation()}
												className="min-w-0 w-full rounded border border-accent bg-surface px-2 py-1 font-ui text-[13px] text-t1 outline-none"
											/>
										</div>
									);
								}
								return (
									<SortableServiceRow
										key={p.id}
										profile={p}
										isActive={isActive}
										isSelected={isSelected}
										onSelect={handleSelectRow}
										isMobile={isMobile}
										onRenameStart={handleRenameStart}
										renderDrillDown={renderRowDrillDown}
									/>
								);
							})}
						</SortableContext>
						<DragOverlay dropAnimation={null}>
							{activeDragItem ? (
								<div className={cn("flex items-center gap-2 border-l-2 min-h-[48px] px-3", activeDragItem.id === selectedId ? "border-l-accent bg-accent-dim" : "border-l-transparent bg-s2")}>
									<span className="text-base leading-none text-t4">≡</span>
									<span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", activeDragItem.id === activeProfileId ? "bg-accent" : "bg-transparent")} />
									<span className="truncate font-ui text-[13px] font-medium text-t1">{activeDragItem.name}</span>
								</div>
							) : null}
						</DragOverlay>
					</DndContext>
					{isCreating && (
						<div className="border-l-2 border-transparent px-3 py-2">
							<input
								ref={newInputRef}
								type="text"
								placeholder={t("promptManager.servicePrompts.newNamePlaceholder")}
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void handleCreateNew();
									if (e.key === "Escape") {
										setIsCreating(false);
										setNewName("");
									}
								}}
								onBlur={() => {
									if (!newName.trim()) setIsCreating(false);
									else void handleCreateNew();
								}}
								className="w-full rounded border border-border bg-s2 px-2 py-1.5 font-ui text-[13px] text-t1 outline-none focus:border-border2"
							/>
						</div>
					)}
				</div>
			)}
			{loadState === "ready" && (
				<div className="shrink-0 border-t border-border px-3 pt-3">
					<button
						type="button"
						onClick={() => setIsCreating(true)}
						className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[12px] text-t3 hover:border-border hover:bg-s2 hover:text-t1"
					>
						<Icons.Plus />
						{t("promptManager.servicePrompts.newProfile")}
					</button>
				</div>
			)}
			{confirmDeleteId && (
				<DestructiveConfirmModal
					title={t("promptManager.servicePrompts.deleteTitle")}
					body={t("promptManager.servicePrompts.deleteBody")}
					confirmLabel={t("delete")}
					onConfirm={() => void handleDelete(confirmDeleteId)}
					onCancel={() => setConfirmDeleteId(null)}
				/>
			)}
			{pendingSelectId && (
				<DestructiveConfirmModal
					title={t("promptManager.servicePrompts.discardTitle")}
					body={t("promptManager.servicePrompts.discardBody")}
					confirmLabel={t("confirm")}
					onConfirm={confirmDiscard}
					onCancel={() => setPendingSelectId(null)}
				/>
			)}
		</div>
	);

	const detailNode = (
		<div className="flex flex-col gap-6">
			{detailState === "loading" && <div className="font-ui text-[13px] text-t3">{t("loading")}</div>}
			{detailState === "error" && (
				<div>
					<div className="font-ui text-[13px] text-danger">
						{tDynamic(detailErrorKey ?? "promptManager.servicePrompts.detailError")}
					</div>
					<button
						type="button"
						onClick={() => setDetailNonce((n) => n + 1)}
						className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[12px] text-t2 hover:bg-s3"
					>
						{t("retry")}
					</button>
				</div>
			)}
			{detailState === "ready" && detail && (
				<>
					{!isDefaultSelected && (
						<label className={lblCls}>
							{t("promptManager.servicePrompts.profileName")}
							<input
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
								className="mt-1 w-full rounded-md border border-border bg-s2 px-2.5 py-2 font-ui text-[13px] text-t1 outline-none focus:border-accent"
							/>
						</label>
					)}
					{isDefaultSelected && (
						<div className="rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[13px] text-t2">
							<span className="font-medium text-t1">{detail.profile.name}</span>
							<span className="ml-2 text-t3">{t("promptManager.servicePrompts.defaultReadOnlyHint")}</span>
						</div>
					)}
					{FAMILY_ORDER.map((family) => {
						const keys = SERVICE_PROMPT_FIELD_KEYS.filter((k) => SERVICE_PROMPT_FIELDS[k].family === family);
						if (keys.length === 0) return null;
						const isOpen = expandedFamilies[family] ?? false;
						return (
							<section key={family} className="flex flex-col rounded-md border border-border">
								<button
									type="button"
									onClick={() => toggleFamily(family)}
									className="flex w-full items-center justify-between px-3 py-2.5 text-left"
								>
									<span className="font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t3">
										{tDynamic(FAMILY_LABEL_KEYS[family])}
									</span>
									<span className="ml-2 flex shrink-0 text-t4">
										<Icons.Caret direction={isOpen ? "u" : "d"} />
									</span>
								</button>
								<AnimatedDisclosure open={isOpen}>
									<div className="flex flex-col gap-4 px-3 pb-3">
										{keys.map((field) => {
											const labelKey = FIELD_LABEL_KEYS[field] ?? `promptManager.servicePrompts.field.${field}`;
											const resolved = detail.resolved[field];
											const overrideValue = draftOverrides[field] ?? "";
											const hasOverride = overrideValue.trim().length > 0;
											const defaultText = resolved.default;
											const placeholder = truncateForPlaceholder(defaultText);
											if (isDefaultSelected) {
												return (
													<div key={field} className="flex flex-col gap-1.5">
														<label className={lblCls}>{tDynamic(labelKey)}</label>
														<AutoTextarea className={monoCls} value={defaultText} disabled minRows={2} />
													</div>
												);
											}
											return (
												<div key={field} className="flex flex-col gap-1.5">
													<div className="flex items-center justify-between">
														<label className={lblCls}>{tDynamic(labelKey)}</label>
														<div className="flex items-center gap-2">
															<span className="font-ui text-[11px] text-t4">
																{tDynamic("promptManager.servicePrompts.charCount", { count: overrideValue.length })}
															</span>
															{hasOverride && (
																<button
																	type="button"
																	onClick={() => handleResetField(field)}
																	className="rounded border border-border bg-transparent px-2 py-0.5 font-ui text-[11px] text-t3 hover:bg-s2 hover:text-t1"
																>
																	{tDynamic("promptManager.servicePrompts.reset")}
																</button>
															)}
														</div>
													</div>
													<AutoTextarea
														className={monoCls}
														value={overrideValue}
														onChange={(e) => handleFieldChange(field, e.target.value)}
														placeholder={placeholder}
														minRows={2}
													/>
												</div>
											);
										})}
									</div>
								</AnimatedDisclosure>
							</section>
						);
					})}
				</>
			)}
		</div>
	);

	const footer = (
		<MasterDetailFooter
			actions={detailState === "ready" && detail ? footerActions : []}
			onClose={onClose}
			right={
				detailState === "ready" && detail && !isDefaultSelected ? (
					<SaveButton dirty={dirty} saveState={saving ? "saving" : "idle"} onClick={() => void handleSave()} label={t("save_btn")} resetKey={detail.profile.id} />
				) : undefined
			}
		/>
	);

	return children({ master, detail: detailNode, footer, dirty });
}
