/**
 * Update check — compares the running build's version against the latest
 * GitHub release.
 *
 * ## Lifetime / caching
 *
 * The GitHub releases endpoint is unauthenticated, so it's rate-limited to
 * 60 requests/hour per IP. We cache the latest result in `localStorage` for
 * 1 hour; on every call we return the cache immediately if it's fresh, and
 * on stale cache we attempt a fresh fetch but fall back to the stale cache
 * on any error (network, CORS, timeout, parse, non-2xx).
 *
 * ## Silent failure
 *
 * Every error path returns `null` and never throws. The UI treats `null` as
 * "no update / unknown" and renders nothing. Per the spec, connection issues
 * must NOT surface any error to the user.
 *
 * ## Release-build context
 *
 * The running version is exposed by the typed build configuration and baked
 * into the SPA bundle by Bun. The release workflow bumps `package.json`
 * before building, so shipped binaries always report their tagged version
 * here. The browser then asks GitHub for the latest release on the user's
 * behalf — works identically for `.exe`, Linux binary, APK, Docker, and
 * `bun run dev`.
 */

import * as buildConfig from "../build-config.js";

const GITHUB_RELEASES_URL = `${buildConfig.UPDATE_API_BASE}/releases/latest`;
const CACHE_KEY = "vibe-tavern.update-check.v3";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 8000;
const RELEASE_NOTE_COMMIT_SUFFIX_RE = /^([ \t]*(?:[-*+]|\d+\.)[ \t]+.*?)[ \t]+\([0-9a-f]{7,40}\)[ \t]*\r?$/gim;

export interface UpdateInfo {
	/** Normalized latest version without leading `v` (e.g. `"1.2.3"`). */
	latestVersion: string;
	/** Original tag name (e.g. `"v1.2.3"`). Used as the modal header. */
	latestTag: string;
	/** GitHub release page URL (the `html_url` field from the API response). */
	releaseUrl: string;
	/** Markdown body of the release, rendered in the modal. Empty string if absent. */
	releaseNotes: string;
}

/**
 * Cached raw release data from GitHub. We cache the RELEASE FACTS (what
 * GitHub told us), NOT the comparison result — because the running version
 * can change across rebuilds while the cached entry is still fresh, and
 * re-comparing the same release facts against a new current version must
 * yield the correct answer without a refetch.
 */
interface CachedEntry {
	timestamp: number;
	release: RawRelease | null;
}

interface RawRelease {
	latestVersion: string;
	latestTag: string;
	releaseUrl: string;
	releaseNotes: string;
}

interface GitHubReleaseResponse {
	tag_name?: unknown;
	html_url?: unknown;
	body?: unknown;
}

/**
 * Parse a version string into a `[major, minor, patch]` tuple.
 *
 * Accepts an optional leading `v` and ignores any prerelease/build metadata
 * (`-beta.1`, `+build.123`). Returns `null` if the input doesn't open with
 * three dotted numeric components.
 *
 * Examples:
 *   parseSemver("1.2.3")         → [1, 2, 3]
 *   parseSemver("v1.2.3")        → [1, 2, 3]
 *   parseSemver("1.2.3-beta.1")  → [1, 2, 3]
 *   parseSemver("garbage")       → null
 */
export function parseSemver(v: string): [number, number, number] | null {
	const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two version strings semver-style. Returns `>0` if `a > b`, `<0` if
 * `a < b`, and `0` if they're equal (or if either side fails to parse — the
 * safer default is "equal", which suppresses a spurious "update available"
 * notification rather than firing one on garbage input).
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

export function cleanReleaseNotes(notes: string): string {
	return notes.replace(RELEASE_NOTE_COMMIT_SUFFIX_RE, "$1");
}

function readCache(): CachedEntry | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<CachedEntry>;
		if (typeof parsed?.timestamp !== "number") return null;
		const release = parsed.release;
		if (release === null) return { timestamp: parsed.timestamp, release: null };
		if (
			typeof release !== "object" ||
			typeof release.latestVersion !== "string" ||
			typeof release.latestTag !== "string" ||
			typeof release.releaseUrl !== "string" ||
			typeof release.releaseNotes !== "string"
		) {
			return null;
		}
		return { timestamp: parsed.timestamp, release };
	} catch {
		return null;
	}
}

function writeCache(release: RawRelease | null): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), release }));
	} catch {
		// Quota exceeded / private mode / disabled storage — ignore. The next
		// call will simply refetch; correctness is unaffected.
	}
}

async function fetchReleaseFromGitHub(): Promise<RawRelease | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(GITHUB_RELEASES_URL, {
			headers: { Accept: "application/vnd.github+json" },
			signal: controller.signal,
		});
		if (!resp.ok) return null;
		const body = (await resp.json()) as GitHubReleaseResponse;
		if (typeof body.tag_name !== "string" || typeof body.html_url !== "string") return null;
		return {
			latestVersion: body.tag_name.replace(/^v/, ""),
			latestTag: body.tag_name,
			releaseUrl: body.html_url,
			releaseNotes: typeof body.body === "string" ? body.body : "",
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch the latest GitHub release and decide whether it's newer than
 * `currentVersion`. Returns the `UpdateInfo` if newer, otherwise `null`.
 *
 * The cache stores raw release facts (what GitHub reported), NOT the
 * comparison result. The comparison against `currentVersion` runs fresh on
 * every call — so a rebuild with a different version immediately produces
 * the correct verdict without waiting for the cache to expire.
 *
 * Never throws.
 */
export async function fetchLatestRelease(currentVersion: string): Promise<UpdateInfo | null> {
	const cache = readCache();

	if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
		return pickUpdate(cache.release, currentVersion);
	}

	const fresh = await fetchReleaseFromGitHub();
	const release = fresh ?? cache?.release ?? null;
	if (fresh) writeCache(fresh);

	return pickUpdate(release, currentVersion);
}

function pickUpdate(release: RawRelease | null, currentVersion: string): UpdateInfo | null {
	if (!release) return null;
	return compareSemver(release.latestVersion, currentVersion) > 0
		? {
			latestVersion: release.latestVersion,
			latestTag: release.latestTag,
			releaseUrl: release.releaseUrl,
			releaseNotes: cleanReleaseNotes(release.releaseNotes),
		}
		: null;
}
