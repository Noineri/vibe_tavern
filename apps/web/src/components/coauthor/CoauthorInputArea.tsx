import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { useToolCapableModels } from "./useToolCapableModels.js";
import { listCoauthorModulesAction, setCoauthorModuleAction } from "../../stores/api-actions/chat-actions.js";
import { useChatStore, useProviderStore, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";

/**
 * Co-Author message box (CS-22). A parallel input surface to the RP
 * {@link InputArea}, intentionally leaner: co-author edits a card template,
 * not a roleplay, so the RP-only persona switch, AI-impersonation pill, prompt
 * preset switcher, and image attachments are all absent here.
 *
 * What it keeps:
 * - the message box itself (shared `AutoTextarea`, §9 — no hand-rolled textarea)
 * - the send/cancel handler, reused verbatim from `useChatController`
 *   (`handleSend` / `handleCancelGeneration`) — co-author sends through the same
 *   chat pipeline, just with a different backend strategy
 * - a **quick module switch** (compact inline dropdown of module names, no
 *   modal — the full manager lives in the Sidebar launcher, CS-23)
 * - a favorites pill **filtered by tool capability** (`useToolCapableModels`),
 *   because co-author turns require function-calling; a non-tool model would
 *   silently break the tool loop, so it must not be selectable here
 *
 * The context counter is intentionally NOT here — it is CS-27 (Wave 6).
 */
export function CoauthorInputArea() {
	const { t } = useT();
	const isMobile = useIsMobile();

	// --- Controller + store subscriptions (mirrors RP InputArea's subset) ---
	const chat = useChatController();
	const provider = useProviderProfiles();
	const draft = useChatStore((s) => s.draft);
	const setDraft = useChatStore((s) => s.setDraft);
	const isSending = useIsSending();
	const connection = useProviderStore((s) => s.connection);
	const activeChatId = useChatStore((s) => s.activeChatId);

	const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);
	const canSend = Boolean(draft.trim()) && !isSending && canUseLiveApi;

	// --- Favorites, tool-filtered ---
	const activeProfileId = provider.activeProviderProfile?.id ?? null;
	const favoriteModels = activeProfileId
		? (provider.favoriteModelsByProfile[activeProfileId] ?? [])
		: [];
	const activeModelId = provider.activeProviderProfile?.defaultModel ?? connection.model ?? null;
	const { models: toolCapableModels } = useToolCapableModels(activeProfileId);
	const toolCapableIds = useMemo(
		() => new Set(toolCapableModels.map((m) => m.id)),
		[toolCapableModels],
	);
	// A co-author favorite is only offered if the model can call tools.
	const toolFilteredFavorites = useMemo(
		() => favoriteModels.filter((f) => toolCapableIds.has(f.modelId)),
		[favoriteModels, toolCapableIds],
	);

	const handleSelectModel = (modelId: string) => {
		if (activeProfileId) void provider.handleSelectFavoriteProviderModel(activeProfileId, modelId);
	};

	// --- Send label state machine (same logic as RP InputArea, minus attachments) ---
	function renderSendLabel(): string {
		if (isSending) return t("sending");
		if (canUseLiveApi && draft.trim()) return t("send_message");
		if (!canUseLiveApi) return t("send_unavailable");
		return t("type_a_message");
	}
	const sendLabel = renderSendLabel();
	const sendButtonText = canSend || !draft.trim() ? t("send") : sendLabel || t("send_unavailable");

	const inputProps = {
		placeholder: t("coauthor.input.placeholder"),
		value: draft,
		onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value),
		onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (canSend) void chat.handleSend();
			}
		},
	};

	if (isMobile) {
		return (
			<MobileInput
				inputProps={inputProps}
				isSending={isSending}
				canSend={canSend}
				activeChatId={activeChatId}
				activeModelId={activeModelId}
				toolFilteredFavorites={toolFilteredFavorites}
				onSelectModel={handleSelectModel}
				onSend={() => void chat.handleSend()}
				onCancel={chat.handleCancelGeneration}
				t={t}
				draft={draft}
				setDraft={setDraft}
			/>
		);
	}

	return (
		<DesktopInput
			inputProps={inputProps}
			isSending={isSending}
			canSend={canSend}
			activeChatId={activeChatId}
			activeModelId={activeModelId}
			toolFilteredFavorites={toolFilteredFavorites}
			onSelectModel={handleSelectModel}
			onSend={() => void chat.handleSend()}
			onCancel={chat.handleCancelGeneration}
			sendLabel={sendLabel}
			sendButtonText={sendButtonText}
			t={t}
		/>
	);
}

// ─── Shared dropdown pieces (used by both layouts, so the menu logic isn't
//      duplicated between desktop and mobile like the RP InputArea does it) ──

/** Quick module switch — a compact dropdown of module names (no modal). */
function useModuleSwitch() {
	const { t } = useT();
	const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
	const rawActiveModuleId = useSnapshotStore((s) => s.activeChat?.coauthorModuleId ?? null);
	// Mirror the backend registry's null→default fallback so the active row is
	// highlighted even when no module has been explicitly chosen.
	const activeModuleId = rawActiveModuleId ?? "default";

	const [modules, setModules] = useState<CoauthorModule[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		listCoauthorModulesAction()
			.then((list) => {
				if (!cancelled) setModules(list);
			})
			.catch(() => {
				if (!cancelled) setModules([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const activeModule = modules.find((m) => m.id === activeModuleId) ?? null;
	const activeLabel = activeModule?.name ?? t("coauthor.input.module_switch");

	const handleSelect = async (moduleId: string) => {
		if (!chatId) return;
		await setCoauthorModuleAction(chatId, moduleId);
	};

	return { modules, loading, activeModuleId, activeLabel, handleSelect };
}

// ─── Desktop layout ─────────────────────────────────────────────────────

interface SharedInputProps {
	activeChatId: string | null;
	activeModelId: string | null;
	toolFilteredFavorites: { modelId: string; label: string | null }[];
	onSelectModel: (modelId: string) => void;
	t: (key: string) => string;
}

function DesktopInput({
	inputProps,
	isSending,
	canSend,
	activeChatId,
	activeModelId,
	toolFilteredFavorites,
	onSelectModel,
	onSend,
	onCancel,
	sendLabel,
	sendButtonText,
	t,
}: SharedInputProps & {
	inputProps: {
		placeholder: string;
		value: string;
		onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
		onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	};
	isSending: boolean;
	canSend: boolean;
	onSend: () => void;
	onCancel: () => void;
	sendLabel: string;
	sendButtonText: string;
}) {
	const moduleSwitch = useModuleSwitch();
	const [moduleDropOpen, setModuleDropOpen] = useState(false);
	const [modelDropOpen, setModelDropOpen] = useState(false);
	const moduleDropRef = useRef<HTMLDivElement>(null);
	const modelDropRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!moduleDropOpen && !modelDropOpen) return;
		function handleClick(e: MouseEvent) {
			if (moduleDropRef.current && !moduleDropRef.current.contains(e.target as Node)) {
				setModuleDropOpen(false);
			}
			if (modelDropRef.current && !modelDropRef.current.contains(e.target as Node)) {
				setModelDropOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [moduleDropOpen, modelDropOpen]);

	return (
		<div
			className={cn(
				"relative z-10 shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3.5 transition-opacity duration-200",
				!activeChatId && "pointer-events-none opacity-45",
			)}
		>
			<div className="relative rounded-lg border border-border bg-input-bg transition-colors duration-150 focus-within:border-border2">
				<AutoTextarea
					className="min-h-[55px] w-full resize-none border-0 bg-transparent px-4 pt-[13px] pb-2 font-body text-[15.5px] leading-tight text-t1 outline-none placeholder:text-t4"
					style={{}}
					maxHeight={250}
					{...inputProps}
					rows={1}
				/>

				<div className="relative flex items-center gap-2 pt-1.5 pb-[9px] pl-3 pr-3">
					{/* Quick module switch */}
					<div className="relative" ref={moduleDropRef}>
						<CustomTooltip content={t("coauthor.input.module_switch")}>
							<button
								type="button"
								data-testid="coauthor-module-switch"
								className={cn(
									"flex h-8 max-w-[180px] items-center gap-1.5 rounded-[5px] bg-s2 px-2.5 font-ui text-[12.5px] text-t1 transition-colors hover:bg-s3",
									moduleDropOpen && "bg-s3",
								)}
								onClick={() => setModuleDropOpen((open) => !open)}
							>
								<Icons.sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
								<span className="min-w-0 truncate">{moduleSwitch.activeLabel}</span>
								<Icons.caret direction="d" className="h-3 w-3 shrink-0 text-t3" />
							</button>
						</CustomTooltip>
						{moduleDropOpen && (
							<div className="glass-blur absolute bottom-[calc(100%+8px)] left-0 z-[220] w-[220px] rounded-lg border border-border2 bg-glass-bg py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
								<div className="mb-1 border-b border-border px-4 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
									{t("coauthor.input.module_switch")}
								</div>
								{moduleSwitch.loading && moduleSwitch.modules.length === 0 ? (
									<div className="px-4 py-2 font-ui text-[12px] text-t3">{t("loading")}</div>
								) : (
									<div className="max-h-[200px] overflow-y-auto">
										{moduleSwitch.modules.map((m) => (
											<button
												type="button"
												key={m.id}
												data-testid={`coauthor-module-option-${m.id}`}
												className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left font-ui text-[13px] text-t1 hover:bg-s2"
												onClick={() => {
													void moduleSwitch.handleSelect(m.id);
													setModuleDropOpen(false);
												}}
											>
												<div className="flex w-4 shrink-0 justify-center text-accent-t">
													{m.id === moduleSwitch.activeModuleId && <Icons.check />}
												</div>
												<div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{m.name}</div>
											</button>
										))}
									</div>
								)}
							</div>
						)}
					</div>

					<div className="ml-auto flex items-center gap-[9px]">
						{/* Tool-filtered favorites */}
						<div className="relative flex items-center" ref={modelDropRef}>
							<CustomTooltip content={t("starred_models")}>
								<button
									type="button"
									data-testid="coauthor-favorites-pill"
									className={cn(
										"flex h-8 items-center justify-center rounded-[5px] bg-s2 px-2.5 text-warning-text transition-colors hover:bg-s3 hover:brightness-110",
										modelDropOpen && "bg-s3 brightness-110",
									)}
									onClick={() => setModelDropOpen((open) => !open)}
								>
									<Icons.starFilled />
								</button>
							</CustomTooltip>
							{modelDropOpen && (
								<div className="glass-blur absolute bottom-[calc(100%+8px)] right-0 z-[220] w-[260px] rounded-lg border border-border2 bg-glass-bg py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
									<div className="mb-1 border-b border-border px-4 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
										{t("starred_models")}
									</div>
									{toolFilteredFavorites.length > 0 ? (
										<div className="max-h-[180px] overflow-y-auto">
											{toolFilteredFavorites.map((model) => (
												<div
													key={model.modelId}
													data-testid={`coauthor-fav-model-${model.modelId}`}
													className="flex cursor-pointer items-center gap-2 px-4 py-1.5 font-ui text-[13px] text-t1 hover:bg-s2"
													onClick={() => {
														onSelectModel(model.modelId);
														setModelDropOpen(false);
													}}
												>
													<div className="flex w-4 shrink-0 justify-center text-accent-t">
														{activeModelId === model.modelId && <Icons.check />}
													</div>
													<div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
														{model.label || model.modelId}
													</div>
												</div>
											))}
										</div>
									) : (
										<div className="px-4 py-2 font-ui text-[12px] text-t3">{t("coauthor.input.no_tool_favorites")}</div>
									)}
								</div>
							)}
						</div>

						{isSending ? (
							<button
								type="button"
								className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface px-3.5 font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
								onClick={onCancel}
							>
								{t("cancel")}
							</button>
						) : (
							<CustomTooltip content={sendLabel}>
								<button
									type="button"
									data-testid="coauthor-send-btn"
									className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all duration-150 hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:filter-none"
									disabled={!canSend}
									onClick={onSend}
									aria-label={sendLabel}
								>
									{sendButtonText}
								</button>
							</CustomTooltip>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Mobile layout ──────────────────────────────────────────────────────

function MobileInput({
	inputProps,
	isSending,
	canSend,
	activeChatId,
	activeModelId,
	toolFilteredFavorites,
	onSelectModel,
	onSend,
	onCancel,
	t,
	draft,
	setDraft,
}: SharedInputProps & {
	inputProps: {
		placeholder: string;
		value: string;
		onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
		onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	};
	isSending: boolean;
	canSend: boolean;
	onSend: () => void;
	onCancel: () => void;
	t: (key: string) => string;
	draft: string;
	setDraft: (v: string) => void;
}) {
	const moduleSwitch = useModuleSwitch();
	const [moduleDropOpen, setModuleDropOpen] = useState(false);
	const [modelDropOpen, setModelDropOpen] = useState(false);

	// Auto-expand textarea within 40vh, shrink back when the draft clears.
	const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
	const adjustTextareaHeight = () => {
		const ta = mobileTextareaRef.current;
		if (ta) {
			ta.style.height = "auto";
			ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
		}
	};
	const mobileOnChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		inputProps.onChange(e);
		adjustTextareaHeight();
	};
	useEffect(() => {
		if (!draft) adjustTextareaHeight();
	}, [draft]);

	return (
		<div
			className={cn(
				"relative z-10 shrink-0 border-t border-border bg-surface px-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2",
				!activeChatId && "pointer-events-none opacity-45",
			)}
		>
			<div className="flex flex-col gap-1.5 rounded-xl bg-s2 p-1.5">
				{/* Toolbar row: module switch + favorites */}
				<div className="flex items-center gap-2">
					<button
						type="button"
						data-testid="coauthor-module-switch"
						className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2"
						onClick={() => setModuleDropOpen(true)}
					>
						<Icons.sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
						<span className="max-w-[130px] min-w-0 truncate">{moduleSwitch.activeLabel}</span>
						<Icons.caret direction="d" className="h-3 w-3 shrink-0" />
					</button>

					<button
						type="button"
						data-testid="coauthor-favorites-pill"
						className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-s3 text-warning-text active:bg-s2"
						onClick={() => setModelDropOpen(true)}
					>
						<Icons.starFilled />
					</button>
				</div>

				{/* Input row */}
				<div className="flex items-end gap-2">
					<textarea
						ref={mobileTextareaRef}
						data-testid="coauthor-input-textarea"
						className="max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4 overflow-y-auto"
						placeholder={inputProps.placeholder}
						value={inputProps.value}
						onChange={mobileOnChange}
						onKeyDown={inputProps.onKeyDown}
						rows={1}
					/>
					<div className="flex shrink-0 items-center">
						{isSending ? (
							<button
								type="button"
								className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10"
								onClick={onCancel}
							>
								<span className="text-[11px] font-bold">✕</span>
							</button>
						) : (
							<button
								type="button"
								data-testid="coauthor-send-btn"
								className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-45 active:scale-95"
								disabled={!canSend}
								onClick={onSend}
							>
								<Icons.caret direction="r" />
							</button>
						)}
					</div>
				</div>
			</div>

			<BottomSheet open={moduleDropOpen} onClose={() => setModuleDropOpen(false)} title={t("coauthor.input.module_switch")}>
				<div className="max-h-[50vh] overflow-y-auto">
					{moduleSwitch.modules.map((m) => (
						<button
							type="button"
							key={m.id}
							data-testid={`coauthor-module-option-${m.id}`}
							className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3"
							onClick={() => {
								void moduleSwitch.handleSelect(m.id);
								setModuleDropOpen(false);
							}}
						>
							<div className="w-5 shrink-0 flex justify-center text-accent-t">
								{m.id === moduleSwitch.activeModuleId && <Icons.check />}
							</div>
							<div className="min-w-0 truncate">{m.name}</div>
						</button>
					))}
				</div>
				<div className="mx-4 mt-2 h-px bg-border" />
				<button
					type="button"
					className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3"
					onClick={() => setModuleDropOpen(false)}
				>
					{t("cancel")}
				</button>
			</BottomSheet>

			<BottomSheet open={modelDropOpen} onClose={() => setModelDropOpen(false)} title={t("starred_models")}>
				{toolFilteredFavorites.length > 0 ? (
					<div className="max-h-[50vh] overflow-y-auto">
						{toolFilteredFavorites.map((model) => (
							<button
								type="button"
								key={model.modelId}
								data-testid={`coauthor-fav-model-${model.modelId}`}
								className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3"
								onClick={() => {
									onSelectModel(model.modelId);
									setModelDropOpen(false);
								}}
							>
								<div className="w-5 shrink-0 flex justify-center text-accent-t">
									{activeModelId === model.modelId && <Icons.check />}
								</div>
								<div className="min-w-0 truncate">{model.label || model.modelId}</div>
							</button>
						))}
					</div>
				) : (
					<div className="px-5 py-4 text-[calc(var(--ui-fs)-1px)] text-t3">{t("coauthor.input.no_tool_favorites")}</div>
				)}
				<div className="mx-4 mt-2 h-px bg-border" />
				<button
					type="button"
					className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3"
					onClick={() => setModelDropOpen(false)}
				>
					{t("cancel")}
				</button>
			</BottomSheet>
		</div>
	);
}
