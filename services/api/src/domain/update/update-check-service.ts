/**
 * The single source of truth for "is there an update?".
 *
 * Before this, the browser polled api.github.com directly (version-check.ts)
 * with its own semver comparison, while the server had a second, differently
 * behaving one in updater.ts. Two implementations meant two answers, and the
 * browser's could not distinguish "no build for your architecture" from
 * "GitHub is unreachable" — it only ever knew that a fetch had failed.
 *
 * Caching is in-memory and deliberately asymmetric: successes are cheap to
 * hold for an hour, but FAILURES must be cached too. An offline or
 * rate-limited server that does not cache failures re-hits GitHub on every
 * poll from every open tab, which is how an unauthenticated client earns a
 * 60-requests-per-hour ban.
 */

import {
	checkForUpdateDetailed,
	getCurrentVersion,
	releasePageUrl,
} from "../../server/updater.js";
import { canSelfUpdate, detectInstallKind } from "./update-orchestrator.js";
import type { RuntimeUpdateCheck } from "@vibe-tavern/api-contracts";

const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
	readonly value: RuntimeUpdateCheck;
	readonly expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Test seam — drops the memoized verdict. */
export function clearUpdateCheckCache(): void {
	cache = null;
}

function baseAnswer(): Omit<RuntimeUpdateCheck, "reason" | "available"> {
	return {
		currentVersion: getCurrentVersion(),
		latestVersion: null,
		latestTag: null,
		releaseUrl: releasePageUrl(),
		releaseNotes: "",
		canSelfUpdate: canSelfUpdate(),
		installKind: detectInstallKind(),
	};
}

async function performCheck(): Promise<{ value: RuntimeUpdateCheck; ttl: number }> {
	const base = baseAnswer();
	const outcome = await checkForUpdateDetailed();

	if (outcome.kind === "offline") {
		// Unreachable, rate-limited, or malformed. Short TTL so recovery is
		// quick, but long enough to stop hammering.
		return { value: { ...base, available: false, reason: "offline" }, ttl: FAILURE_TTL_MS };
	}

	if (outcome.kind === "no-asset-for-platform") {
		// A release exists but nothing here can install it. `available` stays
		// false — there is no in-app update to offer — while the version and
		// notes are still reported so the UI can say WHICH release it is and
		// point at the release page.
		return {
			value: {
				...base,
				latestVersion: outcome.latestVersion,
				latestTag: outcome.latestTag,
				releaseNotes: outcome.releaseNotes,
				available: false,
				reason: "no-asset-for-platform",
			},
			ttl: SUCCESS_TTL_MS,
		};
	}

	const result = outcome.result;
	const found = {
		...base,
		latestVersion: result.latestVersion,
		latestTag: result.latestTag,
		releaseNotes: result.releaseNotes,
	};

	if (!result.updateAvailable) {
		return { value: { ...found, available: false, reason: "up-to-date" }, ttl: SUCCESS_TTL_MS };
	}

	// An install kind that cannot self-update (docker, inno-setup, dev) still
	// gets available:true — the badge and the release link must keep working
	// everywhere. canSelfUpdate is what gates the in-app button.
	return { value: { ...found, available: true, reason: "update-available" }, ttl: SUCCESS_TTL_MS };
}

/**
 * The cached update verdict. Never throws — every failure mode is a `reason`.
 *
 * Note this reports availability on EVERY install kind, including docker,
 * inno-setup and dev. Only `canSelfUpdate` differs: the badge and the release
 * link must keep working everywhere, exactly as they did when the browser
 * asked GitHub itself. Only the transport changed.
 */
export async function getUpdateCheck(): Promise<RuntimeUpdateCheck> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.value;

	try {
		const { value, ttl } = await performCheck();
		cache = { value, expiresAt: now + ttl };
		return value;
	} catch (err) {
		// performCheck is written not to throw; if it ever does, an unavailable
		// answer is still better than a 500 to a background poll.
		console.error(
			"[update-check] unexpected failure:",
			err instanceof Error ? err.message : String(err),
		);
		const value: RuntimeUpdateCheck = { ...baseAnswer(), available: false, reason: "offline" };
		cache = { value, expiresAt: now + FAILURE_TTL_MS };
		return value;
	}
}

/**
 * The tag the server currently believes is latest, or null if it does not know.
 * Used to refuse an install whose notes the user was shown for a different
 * version.
 */
export async function currentLatestTag(): Promise<string | null> {
	return (await getUpdateCheck()).latestTag;
}
