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
 * The running version (`__APP_VERSION__`) is baked into the SPA bundle at
 * build time by `vite.config.ts`. The release workflow bumps `package.json`
 * before building, so shipped binaries always report their tagged version
 * here. The browser then asks GitHub for the latest release on the user's
 * behalf — works identically for `.exe`, Linux binary, APK, Docker, and
 * `bun run dev`.
 */

const GITHUB_RELEASES_URL = "https://api.github.com/repos/Noineri/vibe_tavern/releases/latest";
const CACHE_KEY = "vibe-tavern.update-check.v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 8000;

export interface UpdateInfo {
	/** Normalized latest version without leading `v` (e.g. `"1.2.3"`). */
	latestVersion: string;
	/** GitHub release page URL (the `html_url` field from the API response). */
	releaseUrl: string;
}

interface CachedEntry {
	timestamp: number;
	/** `null` when the last check found no newer version OR errored out. */
	data: UpdateInfo | null;
}

interface GitHubReleaseResponse {
	tag_name?: unknown;
	html_url?: unknown;
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

function readCache(): CachedEntry | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<CachedEntry>;
		if (
			typeof parsed?.timestamp !== "number" ||
			(parsed.data !== null && typeof parsed.data !== "object")
		) {
			return null;
		}
		return { timestamp: parsed.timestamp, data: (parsed.data as UpdateInfo | null) ?? null };
	} catch {
		return null;
	}
}

function writeCache(data: UpdateInfo | null): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
	} catch {
		// Quota exceeded / private mode / disabled storage — ignore. The next
		// call will simply refetch; correctness is unaffected.
	}
}

/**
 * Fetch the latest GitHub release and decide whether it's newer than
 * `currentVersion`. Returns the `UpdateInfo` if newer, otherwise `null`.
 *
 * Behavior:
 *   1. Fresh cache (< 1h old) → return cache immediately, no network.
 *   2. Stale or no cache → fetch with an 8s timeout.
 *   3. On any failure → fall back to stale cache, else `null`.
 *
 * Never throws.
 */
export async function fetchLatestRelease(currentVersion: string): Promise<UpdateInfo | null> {
	const cache = readCache();
	if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
		return cache.data;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(GITHUB_RELEASES_URL, {
			headers: { Accept: "application/vnd.github+json" },
			signal: controller.signal,
		});
		if (!resp.ok) return cache?.data ?? null;
		const body = (await resp.json()) as GitHubReleaseResponse;
		if (typeof body.tag_name !== "string" || typeof body.html_url !== "string") {
			return cache?.data ?? null;
		}
		const latestVersion = body.tag_name.replace(/^v/, "");
		const releaseUrl = body.html_url;

		const data: UpdateInfo | null =
			compareSemver(latestVersion, currentVersion) > 0 ? { latestVersion, releaseUrl } : null;

		writeCache(data);
		return data;
	} catch {
		// Network error, CORS block, abort timeout, JSON parse failure — fall
		// back to whatever we have. Spec: connection issues must not surface
		// any UI to the user.
		return cache?.data ?? null;
	} finally {
		clearTimeout(timer);
	}
}
