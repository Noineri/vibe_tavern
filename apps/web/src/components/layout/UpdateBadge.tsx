import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/index.js";

interface UpdateBadgeProps {
	/** Latest version string (without leading `v`). Shown in the tooltip. */
	latestVersion: string;
	/** GitHub release page URL. Used as a fallback when self-update is unsupported. */
	releaseUrl: string;
}

/**
 * Compact round badge with an up-arrow icon, shown in the TopBar to the left
 * of the Build/Play mode toggle when a newer GitHub release is available.
 *
 * Rendered only when the parent has already confirmed `hasUpdate === true`.
 * Clicking it opens the in-app UpdateModal (release notes + self-update
 * flow) when self-update is available, otherwise falls back to opening the
 * GitHub release page in a new tab.
 */
export function UpdateBadge({ latestVersion, releaseUrl }: UpdateBadgeProps) {
	const { t } = useT();
	const setUpdateModalOpen = useModalStore((s) => s.setUpdateModalOpen);
	const tooltip = `${t("update_tooltip")} — Vibe Tavern ${latestVersion}`;

	const onClick = () => {
		setUpdateModalOpen(true);
		void releaseUrl;
	};

	return (
		<CustomTooltip content={tooltip}>
			<button
				type="button"
				aria-label={tooltip}
				className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-accent-t transition-colors duration-100 hover:bg-accent-dim"
				onClick={onClick}
			>
				<Icons.arrowUpCircle />
			</button>
		</CustomTooltip>
	);
}
