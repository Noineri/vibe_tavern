import { useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { TokenCounterPopover } from "../shared/TokenCounterPopover.js";
import { ToolbarSelect } from "../shared/ToolbarSelect.js";
import { QuickSwitchPopover } from "../shared/QuickSwitchPopover.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useModalStore } from "../../stores/modal-store.js";
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
 * - a **quick module switch** (QuickSwitchPopover: compact inline Popover on
 *   desktop, BottomSheet on mobile — with a "Manage Modules" footer that opens
 *   the full CoauthorModuleModal; the Sidebar launcher opens it too, CS-23).
 *   Popover (not Select) so the footer can launch a modal without the body-lock
 *   leak Select's hardcoded DismissableLayer causes — see QuickSwitchPopover
 * - a favorites pill **filtered by tool capability** (`useToolCapableModels`),
 *   because co-author turns require function-calling; a non-tool model would
 *   silently break the tool loop, so it must not be selectable here
 *
 * The context counter (shared `TokenCounterPopover`) surfaces the token
 * breakdown for the active module/profile/lore/memory + history + draft.
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
		activeModelId, favorites, handleSelectModel,
		sendLabel, sendButtonText,
		buckets, inputTokens, permanent, contextSize, maxTokens, availableBudget, tokenState,
	} = data;

	const moduleSwitch = useModuleSwitch();
	const [moduleSwitchOpen, setModuleSwitchOpen] = useState(false);

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
					<QuickSwitchPopover
						open={moduleSwitchOpen}
						onOpenChange={setModuleSwitchOpen}
						title={t("coauthor.input.module_switch")}
						triggerTooltip={t("coauthor.input.module_switch")}
						contentWidth={220}
						align="start"
						items={moduleSwitch.modules.map((m) => ({ value: m.id, label: m.name }))}
						value={moduleSwitch.activeModuleId}
						onSelect={(v) => void moduleSwitch.handleSelect(v)}
						itemTestId={(v) => `coauthor-module-option-${v}`}
						footer={
							<button
								type="button"
								data-testid="coauthor-manage-modules"
								className="flex w-full cursor-pointer items-center gap-1.5 rounded p-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
								onClick={() => {
									setModuleSwitchOpen(false);
									useModalStore.getState().setCoauthorModuleModalOpen(true);
								}}
							>
								<Icons.Edit className="h-3.5 w-3.5" /> {t("coauthor.module.manage")}
							</button>
						}
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
						{/* Context Counter — shared TokenCounterPopover (Radix Popover flyout). */}
						<TokenCounterPopover
							permanent={permanent}
							history={buckets.history}
							inputTokens={inputTokens}
							contextSize={contextSize}
							maxTokens={maxTokens}
							availableBudget={availableBudget}
							tokenState={tokenState}
							align="end"
							permanentItems={[
								{ label: t("coauthor.module.title"), value: buckets.moduleTokens },
								{ label: t("coauthor.module.skills"), value: buckets.skillTokens },
								{ label: t("character_profile"), value: buckets.profileTokens },
								{ label: t("coauthor.context.label"), value: buckets.context },
								{ label: t("context_memory"), value: buckets.memory },
							]}
						/>
						<div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />

						{/* Tool-filtered favorites — desktop Select / mobile BottomSheet (ToolbarSelect). */}
						<ToolbarSelect
							title={t("starred_models")}
							triggerTooltip={t("starred_models")}
							contentWidth={260}
							emptyText={t("coauthor.input.no_tool_favorites")}
							items={favorites.map((m) => ({ value: m.modelId, label: m.label || m.modelId, ...(m.toolSupport === "unsupported" ? { leading: <span className="font-bold text-warning-text">!</span> } : {}) }))}
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
