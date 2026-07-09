/**
 * SidebarFooter — the launcher cluster at the bottom of the desktop sidebar.
 *
 * Renders in two modes: a column of icon circles when the sidebar is collapsed,
 * or a labeled-row `<section>` (top border) when expanded. The item list is
 * supplied by the caller, so RP (prompt-manager + persona) and co-author
 * (author-modules) compose the same primitive with different items. An item is
 * either an icon launcher or an avatar launcher (persona); the persona item
 * optionally carries a right-aligned suffix tag in expanded mode.
 *
 * Extracted from six duplicated footer blocks across `Sidebar.tsx` (collapsed
 * play/build + expanded play/build) and `CoauthorSidebar.tsx` (collapsed +
 * expanded) — SIDEBAR_GOD_OBJECT_AUDIT step 2. Two unifications vs the original
 * inline blocks, both intentional:
 *   - collapsed icon size is unified to `h-9 w-9` (the build-collapsed `h-8`
 *     was drift — play- and coauthor-collapsed were already `h-9`);
 *   - every expanded row now activates on Enter/Space (matching the play-expanded
 *     rows that already had it). The build- and coauthor-expanded rows carried
 *     `role="button" tabIndex={0}` without a key handler — an a11y defect; the
 *     extraction makes them behave as their role promises.
 *
 * In collapsed mode the footer renders only the item circles (a fragment) — the
 * surrounding positioning container (`mt-auto` / `py-2`) stays with the parent,
 * since it differs per surface. In expanded mode the footer owns its `<section>`
 * border-top wrapper.
 */
import { type ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

export interface FooterLauncherAvatar {
	/** Resolved avatar URL, or `null` to render the `fallback`. */
	readonly src: string | null;
	/** Fallback content (typically initials) shown when `src` is null. */
	readonly fallback: string;
}

export interface FooterLauncherItem {
	readonly key: string;
	/** Tooltip (collapsed) and row label (expanded). Already translated by the caller. */
	readonly label: string;
	readonly onClick: () => void;
	/** Static-icon launcher (e.g. `<Icons.Terminal/>`). Mutually exclusive with `avatar`. */
	readonly icon?: ReactNode;
	/** Avatar launcher (persona). Mutually exclusive with `icon`. */
	readonly avatar?: FooterLauncherAvatar;
	/** Optional right-aligned tag shown only in expanded mode (e.g. the "your persona" label). */
	readonly expandedSuffix?: ReactNode;
}

interface SidebarFooterProps {
	readonly items: FooterLauncherItem[];
	/** Icon-circle column (collapsed rail) vs labeled-row section (expanded). */
	readonly collapsed?: boolean;
}

export function SidebarFooter({ items, collapsed = false }: SidebarFooterProps) {
	return collapsed ? <SidebarFooterCollapsed items={items} /> : <SidebarFooterExpanded items={items} />;
}

function AvatarContent({ avatar }: { avatar: FooterLauncherAvatar }) {
	return avatar.src ? (
		<img src={avatar.src} alt="" className="h-full w-full object-cover" />
	) : (
		<>{avatar.fallback}</>
	);
}

function SidebarFooterCollapsed({ items }: { items: FooterLauncherItem[] }) {
	return (
		<>
			{items.map((item) => (
				<CustomTooltip key={item.key} content={item.label} side="right">
					<div
						className={cn(
							"flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1",
							item.avatar && "overflow-hidden",
						)}
						onClick={item.onClick}
					>
						{item.avatar ? <AvatarContent avatar={item.avatar} /> : item.icon}
					</div>
				</CustomTooltip>
			))}
		</>
	);
}

function SidebarFooterExpanded({ items }: { items: FooterLauncherItem[] }) {
	return (
		<section className="shrink-0 border-t border-border px-1 py-1.5">
			{items.map((item) => {
				const isAvatar = Boolean(item.avatar);
				return (
					<div
						key={item.key}
						className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
						role="button"
						tabIndex={0}
						onClick={item.onClick}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								item.onClick();
							}
						}}
					>
						<span
							className={cn(
								"flex shrink-0 items-center justify-center overflow-hidden rounded-full font-ui not-italic text-t2",
								isAvatar
									? "h-8 w-8 bg-s3 text-[calc(var(--ui-fs)-2px)]"
									: "h-6 w-6 bg-transparent text-[calc(var(--ui-fs)-3px)]",
							)}
						>
							{isAvatar ? <AvatarContent avatar={item.avatar!} /> : item.icon}
						</span>
						<span>{item.label}</span>
						{item.expandedSuffix && (
							<span className="ml-auto shrink-0 text-[calc(var(--ui-fs)-3px)] text-t3">{item.expandedSuffix}</span>
						)}
					</div>
				);
			})}
		</section>
	);
}
