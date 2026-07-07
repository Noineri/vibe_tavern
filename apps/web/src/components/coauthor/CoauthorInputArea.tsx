import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { ToolbarSelect } from "../shared/ToolbarSelect.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { CoauthorMobileInputArea } from "./CoauthorMobileInputArea.js";
import { useCoauthorInputArea, useModuleSwitch } from "./use-coauthor-input-area.js";

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
 * - a **quick module switch** (ToolbarSelect: compact inline Select on desktop,
 *   BottomSheet on mobile — no modal; the full manager lives in the Sidebar
 *   launcher, CS-23)
 * - a favorites pill **filtered by tool capability** (`useToolCapableModels`),
 *   because co-author turns require function-calling; a non-tool model would
 *   silently break the tool loop, so it must not be selectable here
 *
 * The context counter is intentionally NOT here — it is CS-27 (Wave 6).
 *
 * Viewport fork: this file is the router (useCoauthorInputArea + useIsMobile →
 * fork) + the desktop shell; the mobile shell lives in
 * CoauthorMobileInputArea.tsx. The shared data layer is in
 * use-coauthor-input-area.ts. Mirrors the RP InputArea fork (b4e0aa5f).
 */
export function CoauthorInputArea() {
	const data = useCoauthorInputArea();
	const isMobile = useIsMobile();

	if (isMobile) return <CoauthorMobileInputArea data={data} />;
	return <DesktopInput data={data} />;
}

function DesktopInput({ data }: { data: ReturnType<typeof useCoauthorInputArea> }) {
	const {
		t, chat,
		draft, setDraft, isSending, activeChatId, canSend,
		activeModelId, toolFilteredFavorites, handleSelectModel,
		sendLabel, sendButtonText,
		buckets, inputTokens, permanent, contextSize, maxTokens, availableBudget, tokenState,
	} = data;

	const moduleSwitch = useModuleSwitch();
	const [tokenPopOpen, setTokenPopOpen] = useState(false);
	const tokenPopRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!tokenPopOpen) return;
		function handleClick(e: MouseEvent) {
			if (tokenPopRef.current && !tokenPopRef.current.contains(e.target as Node)) {
				setTokenPopOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [tokenPopOpen]);

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
					maxRows={12}
					minRows={3}
					placeholder={t("coauthor.input.placeholder")}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							if (canSend) void chat.handleSend();
						}
					}}
				/>

				<div className="relative flex items-center gap-2 pt-1.5 pb-[9px] pl-3 pr-3">
					{/* Quick module switch — desktop Select / mobile BottomSheet (ToolbarSelect). */}
					<ToolbarSelect
						title={t("coauthor.input.module_switch")}
						triggerTooltip={t("coauthor.input.module_switch")}
						contentWidth={220}
						align="start"
						items={moduleSwitch.modules.map((m) => ({ value: m.id, label: m.name }))}
						value={moduleSwitch.activeModuleId}
						onSelect={(v) => void moduleSwitch.handleSelect(v)}
						itemTestId={(v) => `coauthor-module-option-${v}`}
						trigger={
							<button
								type="button"
								data-testid="coauthor-module-switch"
								className="flex h-8 max-w-[180px] items-center gap-1.5 rounded-[5px] bg-s2 px-2.5 font-ui text-[12.5px] text-t1 transition-colors hover:bg-s3"
							>
								<Icons.Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
								<span className="min-w-0 truncate">{moduleSwitch.activeLabel}</span>
								<Icons.Caret direction="d" className="h-3 w-3 shrink-0 text-t3" />
							</button>
						}
					/>

					<div className="ml-auto flex items-center gap-[9px]">
						{/* Context Counter */}
						<div className="relative" ref={tokenPopRef}>
							<span
								className={cn(
									"cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1",
									tokenState === "warn" ? "text-danger-text" : tokenState === "mid" ? "text-warning-text" : "text-t3",
								)}
								onClick={() => setTokenPopOpen((open) => !open)}
							>
								{permanent.toLocaleString()}<span className="text-t4">+</span>{(buckets.history + inputTokens).toLocaleString()} / {contextSize > 0 ? contextSize.toLocaleString() : "∞"}
							</span>
							{tokenPopOpen && (
								<div className="glass-blur absolute bottom-[calc(100%+8px)] right-0 z-[220] w-[240px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
									<div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("context_breakdown")}</div>
									<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_permanent")}</div>
									<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("coauthor.module.title")}</span><span className="tabular-nums text-t1">{buckets.moduleTokens.toLocaleString()}</span></div>
									<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("coauthor.module.skills")}</span><span className="tabular-nums text-t1">{buckets.skillTokens.toLocaleString()}</span></div>
									<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("character_profile")}</span><span className="tabular-nums text-t1">{buckets.profileTokens.toLocaleString()}</span></div>
									<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_lore")}</span><span className="tabular-nums text-t1">{buckets.lore.toLocaleString()}</span></div>
									<div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_memory")}</span><span className="tabular-nums text-t1">{buckets.memory.toLocaleString()}</span></div>

									<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_temporary")}</div>
									<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_history")}</span><span className="tabular-nums text-t1">{buckets.history.toLocaleString()}</span></div>
									<div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_current_input")}</span><span className="tabular-nums text-t1">{inputTokens.toLocaleString()}</span></div>

									<div className="mb-1 flex justify-between border-t border-border pt-1.5 text-xs text-t2"><span>{t("context_response_budget")}</span><span className="tabular-nums text-t1">{maxTokens === -1 ? '∞' : `-${maxTokens.toLocaleString()}`}</span></div>
									<div className="mt-0.5 flex justify-between text-xs font-medium text-t1"><span>{t("context_total_available")}</span><span className="tabular-nums">{maxTokens === -1 ? '∞' : availableBudget.toLocaleString()}</span></div>

									{availableBudget > 0 && (
										<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-s3">
											<div className="flex h-full">
												<CustomTooltip content={`${t("context_permanent")}: ${permanent.toLocaleString()}`}>
													<div className="bg-accent" style={{ width: `${Math.min(100, permanent / availableBudget * 100)}%` }} />
												</CustomTooltip>
												<CustomTooltip content={`${t("context_history")}: ${buckets.history.toLocaleString()}`}>
													<div className="bg-t3" style={{ width: `${Math.min(100, buckets.history / availableBudget * 100)}%` }} />
												</CustomTooltip>
												<CustomTooltip content={`${t("context_current_input")}: ${inputTokens.toLocaleString()}`}>
													<div className="bg-accent-t" style={{ width: `${Math.min(100, inputTokens / availableBudget * 100)}%` }} />
												</CustomTooltip>
											</div>
										</div>
									)}
								</div>
							)}
						</div>
						<div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />

						{/* Tool-filtered favorites — desktop Select / mobile BottomSheet (ToolbarSelect). */}
						<ToolbarSelect
							title={t("starred_models")}
							triggerTooltip={t("starred_models")}
							contentWidth={260}
							emptyText={t("coauthor.input.no_tool_favorites")}
							items={toolFilteredFavorites.map((m) => ({ value: m.modelId, label: m.label || m.modelId }))}
							value={activeModelId}
							onSelect={handleSelectModel}
							itemTestId={(v) => `coauthor-fav-model-${v}`}
							trigger={
								<button
									type="button"
									data-testid="coauthor-favorites-pill"
									className="flex h-8 items-center justify-center rounded-[5px] bg-s2 px-2.5 text-warning-text transition-colors hover:bg-s3 hover:brightness-110"
								>
									<Icons.StarFilled />
								</button>
							}
						/>

						{isSending ? (
							<button
								type="button"
								className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface px-3.5 font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
								onClick={chat.handleCancelGeneration}
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
									onClick={() => void chat.handleSend()}
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
