import { Toggle } from "../../shared/Toggle.js";
import { useT } from "../../../i18n/context.js";
import { Icons } from "../../shared/icons.js";

interface TweaksSettings {
	theme: 'dark' | 'light';
	fontSize: number;
	uiFontSize: number;
	messageWidth: 'narrow' | 'medium' | 'wide';
	lang: string;
	showRail: boolean;
}

interface MobileSettingsProps {
	open: boolean;
	onClose: () => void;
	settings: TweaksSettings;
	setSetting: (key: string, value: unknown) => void;
	onOpenMobileAccess: () => void;
}

export function MobileSettings({ open, onClose, settings, setSetting, onOpenMobileAccess }: MobileSettingsProps) {
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

			{/* Content */}
			<div className="flex-1 overflow-y-auto overscroll-y-none" style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}>
			{/* ── Live Preview ── */}
			<div className="border-b border-border">
				<div className="px-5 pt-4 pb-2">
					<div className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.08em] text-t3">{t("preview")}</div>
				</div>
				<div className="px-4 pb-4">
					<div className="overflow-hidden rounded-lg border border-border2 bg-surface">
						<div className="px-3 pt-3 pb-1">
							<div className="mb-1.5 flex items-center gap-2">
								<div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-body text-[9px] font-semibold text-on-accent">S</div>
								<span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2">Silvius</span>
								<span className="ml-auto font-ui text-[calc(var(--ui-fs)-5px)] text-t3">12:45</span>
							</div>
							<div className="font-body text-[length:var(--mfs)] leading-[1.55] text-t1 opacity-90">
								"The door groans as a tall figure steps from the shadows, silver eyes catching what little light remains."
							</div>
							<div className="mt-1.5 flex gap-3">
								<Icons.Regen />
								<Icons.Branch />
							</div>
						</div>
						<div className="px-3 pt-2 pb-3">
							<div className="mb-1.5 flex items-center gap-2">
								<div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[9px] italic text-t3">U</div>
								<span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2">You</span>
							</div>
							<div className="my-0.5 rounded-md bg-user-bg px-3 py-2.5">
								<div className="font-body text-[length:var(--mfs)] leading-[1.55] text-t1 opacity-90">
									Hello? Are you... are you hurt?
								</div>
							</div>
						</div>
						<div className="border-t border-border px-3 py-2.5">
							<div className="flex items-center gap-2">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-s3 text-t3"><Icons.User /></div>
								<div className="flex-1 rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">Type a message...</div>
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"><Icons.Caret direction="r" /></div>
							</div>
						</div>
					</div>
				</div>
			</div>


				{/* Appearance */}
				<div className="px-5 pt-5 pb-2">
					<div className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.08em] text-t3">{t("tweaks_theme")}</div>
				</div>

				{/* Theme toggle */}
				<div className="px-5 py-2.5">
					<div className="flex min-h-[48px] items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-s2 text-t2">
								{settings.theme === "dark" ? <Icons.Moon /> : <Icons.Sun />}
							</div>
							<span className="font-body text-[length:var(--ui-fs)] text-t1">{t("tweaks_dark_theme")}</span>
						</div>
						<Toggle checked={settings.theme === "dark"} onChange={(checked) => setSetting("theme", checked ? "dark" : "light")} className="text-[18px]" />
					</div>
				</div>

				{/* Show Rail toggle */}
				<div className="px-5 py-2.5">
					<div className="flex min-h-[48px] items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-s2 text-t2">
								<Icons.Menu />
							</div>
							<span className="font-body text-[length:var(--ui-fs)] text-t1">{settings.showRail ? t("hide_rail") : t("show_rail")}</span>
						</div>
						<Toggle checked={settings.showRail} onChange={(checked) => setSetting("showRail", checked)} className="text-[18px]" />
					</div>
				</div>

				{/* Chat font size */}
				<div className="px-5 py-2.5">
					<div className="flex items-center gap-3 mb-2">
						<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-s2 text-t2">
							<span className="font-body text-[16px] font-bold">A</span>
						</div>
						<span className="font-body text-[length:var(--ui-fs)] text-t1">{t("tweaks_font_size")}</span>
						<span className="ml-auto font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3">{settings.fontSize}px</span>
					</div>
					<input
						type="range" min={14} max={22} step={1}
						className="w-full accent-accent h-2"
						value={settings.fontSize}
						onChange={(e) => setSetting("fontSize", parseInt(e.target.value))}
					/>
				</div>

				{/* UI font size */}
				<div className="px-5 py-2.5">
					<div className="flex items-center gap-3 mb-2">
						<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-s2 text-t2">
							<Icons.Sliders />
						</div>
						<span className="font-body text-[length:var(--ui-fs)] text-t1">{t("tweaks_ui_font_size")}</span>
						<span className="ml-auto font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3">{settings.uiFontSize}px</span>
					</div>
					<input
						type="range" min={14} max={20} step={1}
						className="w-full accent-accent h-2"
						value={settings.uiFontSize}
						onChange={(e) => setSetting("uiFontSize", parseInt(e.target.value))}
					/>
				</div>

				{/* Language */}
				<div className="px-5 pt-5 pb-2">
					<div className="font-ui text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.08em] text-t3">{t("tweaks_language")}</div>
				</div>

				<div className="px-5 py-2.5">
					<div className="flex items-center gap-3 mb-2.5">
						<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-s2 text-t2">
							<Icons.Help />
						</div>
						<span className="font-body text-[length:var(--ui-fs)] text-t1">{t("tweaks_language")}</span>
					</div>
					<div className="flex rounded-lg border border-border bg-s2 p-0.5">
						{([
							{ value: "en", label: "English" },
							{ value: "ru", label: "Русский" },
						] as const).map((l) => (
							<button type="button"
								key={l.value}
								className={`flex flex-1 cursor-pointer items-center justify-center rounded-md py-2.5 font-ui text-[calc(var(--ui-fs)-3px)] transition-colors min-h-[40px] ${
									settings.lang === l.value
										? "bg-surface text-t1 font-medium shadow-sm"
										: "text-t3 active:text-t2"
								}`}
								onClick={() => setSetting("lang", l.value)}
							>
								{l.label}
							</button>
						))}
					</div>
				</div>

				{/* Safe area spacer */}
				<div className="h-[env(safe-area-inset-bottom,0px)]" />
				<div className="h-4" />
			</div>
		</div>
	);
}
