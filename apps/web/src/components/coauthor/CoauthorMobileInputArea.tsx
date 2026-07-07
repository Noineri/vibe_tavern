// Mobile co-author input — a compact two-row surface (toolbar row with module
// switch + favorites pill, then the textarea + send row). Extracted from
// CoauthorInputArea.tsx so the viewport fork is a presentational split
// mirroring the RP MobileInputArea (b4e0aa5f): this file owns only
// mobile-specific UI state (the two BottomSheet open-flags and the auto-grow
// textarea ref); all shared data comes from useCoauthorInputArea().
//
// The two pickers (module switch / tool-filtered favorites) are BottomSheets
// per the project rule that every mobile popover surfaces as a bottom sheet.

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { useModuleSwitch, type CoauthorInputAreaData } from "./use-coauthor-input-area.js";

export function CoauthorMobileInputArea({ data }: { data: CoauthorInputAreaData }) {
	const {
		t, chat,
		draft, setDraft, isSending, activeChatId, canSend,
		activeModelId, toolFilteredFavorites, handleSelectModel,
	} = data;

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
									handleSelectModel(model.modelId);
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
