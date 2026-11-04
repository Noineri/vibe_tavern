import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";
import { SETTINGS_SECTION } from "../../lib/settings-section-registry.js";
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
 * Clicking it opens the settings modal on О программе (release notes +
 * self-update flow) via the same deep link the update toast uses.
 */
export function UpdateBadge({ latestVersion, releaseUrl }: UpdateBadgeProps) {
	const { t } = useT();
	const openSettings = useModalStore((s) => s.openSettings);
	const tooltip = `${t("update_tooltip")} — Vibe Tavern ${latestVersion}`;

	const onClick = () => {
		openSettings(SETTINGS_SECTION.about);
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
