import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { lblCls, codeQuoteCls, listHeaderCls } from "../../../lib/field-tokens.js";
import { TextInput } from "../../shared/text-input.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { FIELD_LABEL_KEYS } from "./service-prompt-field-labels.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { MasterList } from "../../shared/master-list/master-list.js";
import { MasterListRow } from "../../shared/master-list/master-list-row.js";
import { MasterListPhoneRow, SortableMasterListPhoneRow } from "../../shared/master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../../shared/master-list/master-list-overlay-row.js";
import { arrayMove } from "@dnd-kit/sortable";
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

const ALL_FAMILIES: readonly ServicePromptFieldFamily[] = Object.values(SERVICE_PROMPT_FIELD_FAMILIES);

const FAMILY_LABEL_KEYS: Record<ServicePromptFieldFamily, string> = {
	[SERVICE_PROMPT_FIELD_FAMILIES.assistant]: "promptManager.servicePrompts.family.assistant",
	[SERVICE_PROMPT_FIELD_FAMILIES.summary]: "promptManager.servicePrompts.family.summary",
	[SERVICE_PROMPT_FIELD_FAMILIES.insights]: "promptManager.servicePrompts.family.insights",
	[SERVICE_PROMPT_FIELD_FAMILIES.bases]: "promptManager.servicePrompts.family.bases",
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

// Row anatomy lives in `shared/master-list` (handle, status slot, wrapping
// title, rename slot, overlay, phone drill-down row). This pane supplies data
// + slots: the Default profile renders as a pinned handle-less row (lock in
// the status slot, LIVE badge in the title), every other profile as a
// sortable phone row (the rename editor in the `rename` slot, the hover/
// mobile edit button + the drill-down seam in trailing, the active dot for
// the live profile in the status slot per the row rules).

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
		for (const family of ALL_FAMILIES) init[family] = false;
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

	// The Default profile has no stored record to order, so it stays pinned
	// at the top of the list (a handle-less row, never in the sortable set).
	// Drag mechanics live in the primitive's hook; only the payload math
	// (`arrayMove` + the default guard) stays here.
	const orderedProfiles = useMemo(() => {
		return defaultProfile ? [defaultProfile, ...nonDefaultProfiles] : [...nonDefaultProfiles];
	}, [defaultProfile, nonDefaultProfiles]);

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

	const masterHeader = (
		<div className="shrink-0 px-[13px]">
			<div className={cn(listHeaderCls, "pb-[5px] pt-1")}>
				{t("promptManager.servicePrompts.masterTitle")}
			</div>
		</div>
	);

	const renderMasterRow = (p: ServicePromptProfile): ReactNode => {
		const isSelected = selectedId === p.id;
		const isActive = p.isDefault ? activeProfileId === null : activeProfileId === p.id;
		const isRenaming = renamingId === p.id;
		if (isRenaming) {
			return (
				<MasterListRow
					rowTestId={"service-row-" + p.id}
					rename={
						<InlineRenameInput
							ref={renameInputRef}
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleRenameSave();
								if (e.key === "Escape") setRenamingId(null);
							}}
							onBlur={() => void handleRenameSave()}
							onClick={(e) => e.stopPropagation()}
						/>
					}
				/>
			);
		}
		const trailing = (
			<>
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
						// The sortable rows carried an extra mobile margin the pinned
						// Default row never had — kept per row, not unified.
						(!p.isDefault && isMobile) && "ml-1",
					)}
				>
					<Icons.Edit />
				</button>
				{renderRowDrillDown?.(p.id, () => handleSelectRow(p.id))}
			</>
		);
		if (p.isDefault) {
			return (
				<MasterListPhoneRow
					rowTestId={"service-row-" + p.id}
					selected={isSelected}
					active={isActive}
					status={
						<CustomTooltip content="promptManager.servicePrompts.liveTooltip">
							<span className="flex shrink-0 text-t3">
								<Icons.Lock />
							</span>
						</CustomTooltip>
					}
					title={
						<>
							{p.name}
							<span className="ml-1.5 rounded bg-success/15 px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-4px)] text-success">
								{t("promptManager.servicePrompts.liveBadge")}
							</span>
						</>
					}
					onSelect={() => handleSelectRow(p.id)}
					trailing={trailing}
				/>
			);
		}
		return (
			<SortableMasterListPhoneRow
				sortableId={p.id}
				rowTestId={"service-row-" + p.id}
				selected={isSelected}
				active={isActive}
				title={p.name}
				onSelect={() => handleSelectRow(p.id)}
				trailing={trailing}
			/>
		);
	};

	const master = (
		<>
			{loadState !== "ready" ? (
				<div className="flex flex-1 flex-col min-h-0 py-2.5">
					{masterHeader}
			{loadState === "loading" && (
				<div className="px-4 py-6 font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("loading")}</div>
			)}
			{loadState === "error" && (
				<div className="px-4 py-4">
					<div className="font-ui text-[calc(var(--ui-fs)-1px)] text-danger">{t("promptManager.servicePrompts.loadError")}</div>
					<button
						type="button"
						onClick={() => void refreshList()}
						className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s3"
					>
						{t("retry")}
					</button>
				</div>
			)}
				</div>
			) : (
				<MasterList<ServicePromptProfile>
					items={orderedProfiles}
					getId={(p) => p.id}
					// The pinned Default row is never sortable, and the row under
					// inline rename renders an input instead of a sortable (ML-2 pattern).
					sortableIds={orderedProfiles.filter((p) => !p.isDefault && p.id !== renamingId).map((p) => p.id)}
					onReorderItems={(activeId, overId, currentItems) => {
						// The Default row has no stored record: dragging onto it is a noop.
						if (defaultProfile && (activeId === defaultProfile.id || overId === defaultProfile.id)) {
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
							persist: () => reorderServicePromptProfiles(
								reordered.filter((p) => !p.isDefault).map((p, i) => ({ id: p.id, sortOrder: i })),
							).then((res) => {
								setProfiles(res.profiles);
								setActiveProfileId(res.activeProfileId);
							}),
						};
					}}
					header={masterHeader}
					renderRow={renderMasterRow}
					renderOverlayRow={(item) => (
						<MasterListDragOverlayRow
							active={item.isDefault ? activeProfileId === null : activeProfileId === item.id}
							title={item.name}
						/>
					)}
					footer={
						<div className="shrink-0 border-t border-border px-3 pt-3">
							{/* NAMED POSITIONAL CHANGE (ML-2 regex precedent): the inline
							creation input lived at the list scroll-end; it now docks in the
								pinned footer above the "+ New" button (same bottom position,
								no longer scrolls away). */}
							{isCreating ? (
								<InlineRenameInput
									ref={newInputRef}
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
								/>
							) : (
								<button
									type="button"
									onClick={() => setIsCreating(true)}
									className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:border-border hover:bg-s2 hover:text-t1"
								>
									<Icons.Plus />
									{t("promptManager.servicePrompts.newProfile")}
								</button>
							)}
						</div>
					}
				/>
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
		</>
	);

	const renderFieldRow = (field: ServicePromptFieldKey): ReactNode => {
		const labelKey = FIELD_LABEL_KEYS[field] ?? `promptManager.servicePrompts.field.${field}`;
		const resolved = detail?.resolved[field];
		const overrideValue = draftOverrides[field] ?? "";
		const hasOverride = overrideValue.trim().length > 0;
		const defaultText = resolved?.default ?? "";
		const placeholder = truncateForPlaceholder(defaultText);
		if (isDefaultSelected) {
			return (
				<div key={field} className="flex flex-col">
					<label className={lblCls}>{tDynamic(labelKey)}</label>
					<div className={cn(codeQuoteCls, "max-h-40 overflow-auto")}>{defaultText}</div>
				</div>
			);
		}
		return (
			<div key={field} className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<label className={lblCls + " !mb-0"}>{tDynamic(labelKey)}</label>
					<div className="flex items-center gap-2">
						<span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t4">
							{tDynamic("promptManager.servicePrompts.charCount", { count: overrideValue.length })}
						</span>
						{hasOverride && (
							<button
								type="button"
								onClick={() => handleResetField(field)}
								className="rounded border border-border bg-transparent px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 hover:bg-s2 hover:text-t1"
							>
								{tDynamic("promptManager.servicePrompts.reset")}
							</button>
						)}
					</div>
				</div>
				<AutoTextarea
					mono
					value={overrideValue}
					onChange={(e) => handleFieldChange(field, e.target.value)}
					placeholder={placeholder}
					minRows={2}
				/>
			</div>
		);
	};
	const detailNode = (
		<div className="flex flex-col gap-6">
			{detailState === "loading" && <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("loading")}</div>}
			{detailState === "error" && (
				<div>
					<div className="font-ui text-[calc(var(--ui-fs)-1px)] text-danger">
						{tDynamic(detailErrorKey ?? "promptManager.servicePrompts.detailError")}
					</div>
					<button
						type="button"
						onClick={() => setDetailNonce((n) => n + 1)}
						className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s3"
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
							<TextInput
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
							/>
						</label>
					)}
					{isDefaultSelected && (
						<div className="rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t2">
							<span className="font-medium text-t1">{detail.profile.name}</span>
							<span className="ml-2 text-t3">{t("promptManager.servicePrompts.defaultReadOnlyHint")}</span>
						</div>
					)}
					{ALL_FAMILIES.map((family) => {
						const keys = SERVICE_PROMPT_FIELD_KEYS.filter((key) => SERVICE_PROMPT_FIELDS[key].family === family);
						const isOpen = expandedFamilies[family] ?? false;
						return (
							<section key={family} className="flex flex-col rounded-md border border-border">
								<button
									type="button"
									onClick={() => toggleFamily(family)}
									className="flex w-full items-center justify-between px-3 py-2.5 text-left"
								>
									<span className="font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.08em] text-t3">
										{tDynamic(FAMILY_LABEL_KEYS[family])}
									</span>
									<span className="ml-2 flex shrink-0 text-t4">
										<Icons.Caret direction={isOpen ? "u" : "d"} />
									</span>
								</button>
								<AnimatedDisclosure open={isOpen}>
									<div className="flex flex-col gap-4 px-3 pb-3">{keys.map(renderFieldRow)}</div>
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
