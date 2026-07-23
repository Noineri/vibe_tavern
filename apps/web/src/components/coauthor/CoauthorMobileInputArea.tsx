// Mobile co-author input — a compact two-row surface (toolbar row with module
// switch + favorites pill, then the textarea + send row). Extracted from
// CoauthorInputArea.tsx so the viewport fork is a presentational split
// mirroring the RP MobileInputArea (b4e0aa5f): this file owns only
// mobile-specific UI state (the auto-grow textarea ref); the module / favorites
// pickers are the mobile half of `QuickSwitchPopover` (module switch, with a
// "Manage Modules" footer) and `ToolbarSelect` (favorites) — both BottomSheet, vaul.

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { ToolbarSelect } from "../shared/ToolbarSelect.js";
import { QuickSwitchPopover } from "../shared/QuickSwitchPopover.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useModuleSwitch, type CoauthorInputAreaData } from "./use-coauthor-input-area.js";

export function CoauthorMobileInputArea({ data }: { data: CoauthorInputAreaData }) {
	const {
		t, chat,
		draft, setDraft, isSending, activeChatId, canSend,
		activeModelId, favorites, handleSelectModel,
	} = data;

	const moduleSwitch = useModuleSwitch();
	const [moduleSwitchOpen, setModuleSwitchOpen] = useState(false);

	// Auto-expand textarea within 40vh, shrink back when the draft clears.
	const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
	const adjustTextareaHeight = () => {
		const ta = mobileTextareaRef.current;
		if (ta) {
			ta.style.height = "auto";
			ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
		}
	};
	const mobileOnChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
		setDraft(e.target.value);
		adjustTextareaHeight();
	};
	const mobileOnKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (canSend) void chat.handleSend();
		}
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
				{/* Toolbar row: module switch + favorites (ToolbarSelect mobile → BottomSheet) */}
				<div className="flex items-center gap-2">
					<QuickSwitchPopover
						mobile
						open={moduleSwitchOpen}
						onOpenChange={setModuleSwitchOpen}
						title={t("coauthor.input.module_switch")}
						items={moduleSwitch.modules.map((m) => ({ value: m.id, label: m.name }))}
						value={moduleSwitch.activeModuleId}
						onSelect={(v) => void moduleSwitch.handleSelect(v)}
						itemTestId={(v) => `coauthor-module-option-${v}`}
						footer={
							<button
								type="button"
								data-testid="coauthor-manage-modules"
								className="flex w-full min-h-[52px] items-center gap-3 px-5 font-ui text-[calc(var(--ui-fs)-1px)] text-t3 active:bg-s3"
								onClick={() => {
									setModuleSwitchOpen(false);
									useModalStore.getState().setCoauthorModuleModalOpen(true);
								}}
							>
								<Icons.Edit className="h-4 w-4" /> {t("coauthor.module.manage")}
							</button>
						}
						trigger={
							<button
								type="button"
								data-testid="coauthor-module-switch"
								className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2"
							>
								<Icons.Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
								<span className="max-w-[130px] min-w-0 truncate">{moduleSwitch.activeLabel}</span>
								<Icons.Caret direction="d" className="h-3 w-3 shrink-0" />
							</button>
						}
					/>

					<ToolbarSelect
						mobile
						title={t("starred_models")}
						emptyText={t("coauthor.input.no_tool_favorites")}
						items={favorites.map((m) => ({ value: m.modelId, label: m.label || m.modelId, ...(m.toolSupport === "unsupported" ? { leading: <span className="font-bold text-warning-text">!</span> } : {}) }))}
						value={activeModelId}
						onSelect={handleSelectModel}
						itemTestId={(v) => `coauthor-fav-model-${v}`}
						trigger={
							<button
								type="button"
								data-testid="coauthor-favorites-pill"
								className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-s3 text-warning-text active:bg-s2"
							>
								<Icons.StarFilled />
							</button>
						}
					/>
				</div>

				{/* Input row */}
				<div className="flex items-end gap-2">
					<textarea
						ref={mobileTextareaRef}
						data-testid="coauthor-input-textarea"
						className="max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4 overflow-y-auto"
						placeholder={t("coauthor.input.placeholder")}
						value={draft}
						onChange={mobileOnChange}
						onKeyDown={mobileOnKeyDown}
						rows={1}
					/>
					<div className="flex shrink-0 items-center">
						{isSending ? (
							<button
								type="button"
								className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10"
								onClick={chat.handleCancelGeneration}
							>
								<span className="text-[11px] font-bold">✕</span>
							</button>
						) : (
							<button
								type="button"
								data-testid="coauthor-send-btn"
								className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-45 active:scale-95"
								disabled={!canSend}
								onClick={() => void chat.handleSend()}
							>
								<Icons.Caret direction="r" />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
