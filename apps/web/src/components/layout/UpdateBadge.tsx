import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";

interface UpdateBadgeProps {
	/** Latest version string (without leading `v`). Shown in the tooltip. */
	latestVersion: string;
	/** GitHub release page URL. Opened in a new tab on click. */
	releaseUrl: string;
}

/**
 * Compact round badge with an up-arrow icon, shown in the TopBar to the left
 * of the Build/Play mode toggle when a newer GitHub release is available.
 *
 * Rendered only when the parent has already confirmed `hasUpdate === true`.
 * Clicking it opens the GitHub release page in a new tab. Uses theme tokens
 * (`text-accent-t`, `bg-accent-dim`) so it picks up the active palette in all
 * 5 themes without per-theme overrides.
 */
export function UpdateBadge({ latestVersion, releaseUrl }: UpdateBadgeProps) {
	const { t } = useT();
	const tooltip = `${t("update_tooltip")} — Vibe Tavern ${latestVersion}`;

	return (
		<CustomTooltip content={tooltip}>
			<button
				type="button"
				aria-label={tooltip}
				className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-accent-t transition-colors duration-100 hover:bg-accent-dim"
				onClick={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}
			>
				<Icons.ArrowUpCircle />
			</button>
		</CustomTooltip>
	);
}
