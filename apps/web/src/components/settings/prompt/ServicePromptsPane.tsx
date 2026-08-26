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
import { monoCls, lblCls } from "../../build/fields/field-styles.js";
import {
	createServicePromptProfile,
	deleteServicePromptProfile,
	getServicePromptProfileDetail,
	listServicePromptProfiles,
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

/** Families in desired visual order (insertion order of the domain registry). */
const FAMILY_ORDER: readonly ServicePromptFieldFamily[] = Object.values(SERVICE_PROMPT_FIELD_FAMILIES);

const FAMILY_LABEL_KEYS: Record<ServicePromptFieldFamily, string> = {
	[SERVICE_PROMPT_FIELD_FAMILIES.assistant]: "promptManager.servicePrompts.family.assistant",
	[SERVICE_PROMPT_FIELD_FAMILIES.summary]: "promptManager.servicePrompts.family.summary",
	[SERVICE_PROMPT_FIELD_FAMILIES.insights]: "promptManager.servicePrompts.family.insights",
	[SERVICE_PROMPT_FIELD_FAMILIES.bases]: "promptManager.servicePrompts.family.bases",
};

/** Existing keys are reused for the 8 assistant modes that already had labels
 *  in the preset editor (PromptFields.tsx); the rest get dedicated keys. */
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

export function ServicePromptsPane({
	active,
	children,
}: {
	active: boolean;
	children: (slots: ServicePromptsPaneSlots) => ReactNode;
}): ReactNode {
	const { t, tDynamic } = useT();
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [profiles, setProfiles] = useState<ServicePromptProfile[]>([]);
	const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	/** Bumped by the detail-retry button — the only way to re-run the fetch
	 *  effect for the SAME selectedId (same-value setState is a no-op). */
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

	// Default pinned first, the rest in server order.
	const orderedProfiles = useMemo(() => {
		const def = profiles.find((p) => p.isDefault);
		const rest = profiles.filter((p) => !p.isDefault);
		return def ? [def, ...rest] : rest;
	}, [profiles]);

	const refreshList = useCallback(async () => {
		setLoadState("loading");
		try {
			const res = await listServicePromptProfiles();
			setProfiles(res.profiles);
			setActiveProfileId(res.activeProfileId);
			setLoadState("ready");
			if (!selectedId && res.profiles.length > 0) {
				const def = res.profiles.find((p) => p.isDefault);
				setSelectedId(def ? def.id : res.profiles[0]!.id);
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

	// Error text is stored as an i18n KEY and translated at render — keeping
	// `t` out of the deps means a locale switch can never re-run this effect
	// (which would silently discard an in-progress draft). `active` is also
	// deliberately absent: re-entering the tab must NOT refetch — the loaded
	// detail and any in-progress draft survive the round-trip (the body guard
	// covers the inactive window; selection can only change while visible).
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

	const handleSelectRow = useCallback(
		(id: string) => {
			if (id === selectedId) return;
			if (dirty) {
				setPendingSelectId(id);
				return;
			}
			setSelectedId(id);
		},
		[dirty, selectedId],
	);

	const confirmDiscard = useCallback(() => {
		if (pendingSelectId) {
			setSelectedId(pendingSelectId);
			setPendingSelectId(null);
		}
	}, [pendingSelectId]);

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
					const def = res.profiles.find((p) => p.isDefault);
					setSelectedId(def ? def.id : (res.profiles[0]?.id ?? null));
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
				// "(copy)" is literal English on purpose — stored data, same rule
				// as the SP-7 migration suffix; it must never be localized.
				const dup = await createServicePromptProfile({
					name: `${profile.name} (copy)`,
					overrides: { ...profile.overrides },
				});
				const res = await listServicePromptProfiles();
				setProfiles(res.profiles);
				setActiveProfileId(res.activeProfileId);
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
			setActiveProfileId(res.activeProfileId);
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

	const handleCancel = useCallback(() => {
		if (!detail) return;
		setDraftName(detail.profile.name);
		setDraftOverrides({ ...detail.profile.overrides });
	}, [detail]);

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
					{orderedProfiles.map((p) => {
						const isSelected = selectedId === p.id;
						const isActive = (activeProfileId === null && p.isDefault) || activeProfileId === p.id;
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
								<button
									type="button"
									aria-label={t("promptManager.servicePrompts.makeActive")}
									aria-checked={isActive}
									role="radio"
									onClick={(e) => {
										e.stopPropagation();
										void handleSetActive(p.id, p.isDefault);
									}}
									className={cn(
										"flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
										isActive ? "border-accent bg-accent" : "border-border2 bg-transparent",
									)}
								>
									{isActive && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
								</button>
								<span
									className={cn("h-[6px] w-[6px] shrink-0 rounded-full", isSelected ? "bg-accent" : "bg-transparent")}
								/>
								{p.isDefault && (
									<CustomTooltip content={t("promptManager.servicePrompts.liveTooltip")}>
										<span className="flex shrink-0 text-t3">
											<Icons.Lock />
										</span>
									</CustomTooltip>
								)}
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
											{p.isDefault && (
												<span className="ml-1.5 rounded bg-success/15 px-1 py-0.5 font-ui text-[10px] text-success">
													{t("promptManager.servicePrompts.liveBadge")}
												</span>
											)}
										</span>
									</CustomTooltip>
								)}
								{!p.isDefault && !isRenaming && (
									<span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
										<button
											type="button"
											aria-label={t("duplicate")}
											data-testid={"duplicate-" + p.id}
											onClick={(e) => {
												e.stopPropagation();
												void handleDuplicate(p);
											}}
											className="rounded p-1 text-t4 hover:bg-s3 hover:text-t1"
										>
											<Icons.Copy />
										</button>
										<button
											type="button"
											aria-label={t("edit")}
											onClick={(e) => {
												e.stopPropagation();
												handleRenameStart(p.id, p.name);
											}}
											className="rounded p-1 text-t4 hover:bg-s3 hover:text-t1"
										>
											<Icons.Edit />
										</button>
										<button
											type="button"
											aria-label={t("delete")}
											onClick={(e) => {
												e.stopPropagation();
												setConfirmDeleteId(p.id);
											}}
											className="rounded p-1 text-t4 hover:bg-s3 hover:text-danger"
										>
											<Icons.Trash />
										</button>
									</span>
								)}
								{p.isDefault && !isRenaming && (
									<span className="ml-auto flex shrink-0 opacity-0 group-hover:opacity-100">
										<button
											type="button"
											aria-label={t("duplicate")}
											data-testid={"duplicate-" + p.id}
											onClick={(e) => {
												e.stopPropagation();
												void handleDuplicate(p);
											}}
											className="rounded p-1 text-t4 hover:bg-s3 hover:text-t1"
										>
											<Icons.Copy />
										</button>
									</span>
								)}
							</div>
						);
					})}
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
						return (
							<section key={family} className="flex flex-col gap-4">
								<div className="font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t3">
									{tDynamic(FAMILY_LABEL_KEYS[family])}
								</div>
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
							</section>
						);
					})}
				</>
			)}
		</div>
	);

	const footer = (
		<div className="shrink-0 border-t border-border bg-surface px-4 py-3">
			{detailState === "ready" && detail && (
				isDefaultSelected ? (
					<button
						type="button"
						onClick={() => void handleDuplicate(detail.profile)}
						className="rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[13px] text-t2 hover:bg-s3"
					>
						{t("promptManager.servicePrompts.duplicateButton")}
					</button>
				) : (
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={!dirty || saving}
							onClick={() => void handleSave()}
							className={cn(
								"rounded-md px-3 py-1.5 font-ui text-[13px] font-medium",
								dirty && !saving ? "bg-accent text-white hover:brightness-110" : "bg-s2 text-t4",
							)}
						>
							{saving ? t("saving") : t("save_btn")}
						</button>
						<button
							type="button"
							disabled={!dirty || saving}
							onClick={handleCancel}
							className={cn(
								"rounded-md border px-3 py-1.5 font-ui text-[13px]",
								dirty ? "border-border text-t2 hover:bg-s2" : "border-transparent text-t4",
							)}
						>
							{t("cancel")}
						</button>
					</div>
				)
			)}
		</div>
	);

	return children({ master, detail: detailNode, footer, dirty });
}
