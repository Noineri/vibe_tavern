import { useT } from "../../../i18n/context.js";
import { Icons } from "../../shared/icons.js";
import { ScrollArea } from "../../shared/scroll-area.js";
import { InterfaceSettingsBody } from "../interface-settings-body.js";
import { useModalStore } from "../../../stores/modal-store.js";
import { SETTINGS_SECTION } from "../../../lib/settings-section-registry.js";

interface MobileSettingsProps {
	open: boolean;
	onClose: () => void;
	onOpenProxyManager?: () => void;
}

export function MobileSettings({ open, onClose, onOpenProxyManager = () => {} }: MobileSettingsProps) {
	const { t } = useT();
	if (!open) return null;

	return (
		<div className="fixed inset-0 z-[400] flex flex-col bg-bg">
			{/* Header */}
			<div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
				<button type="button"
					className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2"
					onClick={onClose}
				>
					<Icons.Caret direction="l" />
				</button>
				<span className="font-ui text-[length:var(--ui-fs)] font-semibold text-t1">{t("tweaks_title")}</span>
			</div>

			{/* Content — CNR-8m: the settings list rides the shared thin vertical
			    lane with flex-1 sizing on the ScrollArea root (it fills the flex
			    remainder under the fixed header, which stays docked outside the
			    scroller). The overscroll-contain and momentum-scrolling hints move
			    onto the native viewport the primitive renders, so phone scrolling
			    behaves exactly as before; the lane chrome hides on phones by the
			    CNR-7g ≤768px policy (thin chrome shows where the sheet is rendered
			    wider than a phone). */}
			<ScrollArea scrollbarSize="thin" className="flex-1" viewportProps={{ className: "overscroll-y-none", style: { WebkitOverflowScrolling: "touch" } as React.CSSProperties }}>
			{/* ── Live Preview ── */}
			<div className="border-b border-border">
				<div className="px-5 pt-4 pb-2">
					<div className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.08em] text-t3">{t("preview")}</div>
				</div>
				<div className="px-4 pb-4">
					<div className="overflow-hidden rounded-lg border border-border2 bg-surface">
						<div className="px-3 pt-3 pb-1">
							<div className="mb-1.5 flex items-center gap-2">
								<div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-body text-[calc(var(--ui-fs)-5px)] font-semibold text-on-accent">S</div>
								<span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2">Silvius</span>
								<span className="ml-auto font-ui text-[calc(var(--ui-fs)-5px)] text-t3">12:45</span>
							</div>
							<div className="font-body text-[length:var(--mfs)] leading-[1.55] text-t1 opacity-90">
								{t("preview_char_message")}
							</div>
							<div className="mt-1.5 flex gap-3">
								<Icons.Regen />
								<Icons.Branch />
							</div>
						</div>
						<div className="px-3 pt-2 pb-3">
							<div className="mb-1.5 flex items-center gap-2">
								<div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)-5px)] italic text-t3">U</div>
								<span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2">You</span>
							</div>
							<div className="my-0.5 rounded-md bg-user-bg px-3 py-2.5">
								<div className="font-body text-[length:var(--mfs)] leading-[1.55] text-t1 opacity-90">
									{t("preview_user_message")}
								</div>
							</div>
						</div>
						<div className="border-t border-border px-3 py-2.5">
							<div className="flex items-center gap-2">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-s3 text-t3"><Icons.User /></div>
								<div className="flex-1 rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("preview_input_placeholder")}</div>
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"><Icons.Caret direction="r" /></div>
							</div>
						</div>
					</div>
				</div>
			</div>


				<InterfaceSettingsBody mobile />

				<div className="px-5 py-2.5">
					<button type="button" className="flex min-h-[48px] w-full items-center justify-between rounded-lg border border-border bg-s2 px-3 text-left text-t2 transition-colors active:bg-s3" onClick={onOpenProxyManager}>
						<span className="flex items-center gap-3"><Icons.Globe />{t("proxies")}</span>
						<Icons.Caret direction="r" />
					</button>
				</div>

				{/* Full settings entry */}
				<div className="px-5 py-2.5">
					<button type="button" className="flex min-h-[48px] w-full items-center justify-between rounded-lg border border-border bg-s2 px-3 text-left text-t2 transition-colors active:bg-s3" onClick={() => useModalStore.getState().openSettings(SETTINGS_SECTION.interface)}>
						<span className="flex items-center gap-3"><Icons.Settings />{t("settings_all")}</span>
						<Icons.Caret direction="r" />
					</button>
				</div>

				{/* Safe area spacer */}
				<div className="h-[env(safe-area-inset-bottom,0px)]" />
				<div className="h-4" />
			</ScrollArea>
		</div>
	);
}
