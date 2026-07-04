import { useEffect, useState } from "react";
import { fetchLatestRelease, type UpdateInfo } from "../lib/version-check.js";

export interface UpdateCheckState {
	/** True only when a strictly newer release was confirmed from GitHub. */
	hasUpdate: boolean;
	/** Latest version string (without leading `v`). Null until confirmed. */
	latestVersion: string | null;
	/** Original tag name (with leading `v`). Used as the modal header. */
	latestTag: string | null;
	/** GitHub release page URL. Null until confirmed. */
	releaseUrl: string | null;
	/** Markdown release notes body. Empty string when GitHub returned no body. */
	releaseNotes: string | null;
}

const IDLE: UpdateCheckState = {
	hasUpdate: false,
	latestVersion: null,
	latestTag: null,
	releaseUrl: null,
	releaseNotes: null,
};

/**
 * Polls GitHub for a newer release of the running build. Fires once on mount;
 * the underlying `fetchLatestRelease` is cached for 1 hour in `localStorage`,
 * so mounting/unmounting (e.g. navigating between routes) does NOT refetch.
 *
 * The hook is silent by design: any network / parse / rate-limit failure
 * leaves the state at `{ hasUpdate: false }` and renders nothing.
 *
 * @param currentVersion The running build's version (typically `__APP_VERSION__`).
 */
export function useUpdateCheck(currentVersion: string): UpdateCheckState {
	const [state, setState] = useState<UpdateCheckState>(IDLE);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const info: UpdateInfo | null = await fetchLatestRelease(currentVersion);
			if (cancelled || !info) return;
			setState({
				hasUpdate: true,
				latestVersion: info.latestVersion,
				latestTag: info.latestTag,
				releaseUrl: info.releaseUrl,
				releaseNotes: info.releaseNotes,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [currentVersion]);

	return state;
}
