/**
 * Pre-update database snapshot.
 *
 * An update that goes wrong is only recoverable if the data from before it
 * still exists. `vibe-tavern rollback` restores the previous binary and web
 * tree; this is the matching recovery point for the database, taken while the
 * old build is still the one running.
 *
 * `VACUUM INTO` is used rather than a file copy because the live database is
 * in WAL mode: copying `vibe-tavern.db` alone would miss everything still in
 * `-wal`, and copying all three files while the server is writing is not
 * atomic. A read-only connection running `VACUUM INTO` produces a single
 * consistent file with no WAL sidecar (verified against an open, uncheckpointed
 * WAL database on the pinned Bun).
 *
 * Deliberately NOT `createDb()` from @vibe-tavern/db: that runs the entire
 * migration stack, which is both wasteful here and actively wrong — it would
 * write to the database we are trying to photograph.
 */

import { Database } from "bun:sqlite";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SnapshotResult {
	readonly ok: boolean;
	readonly path: string | null;
	readonly bytes: number;
	readonly message: string | null;
}

/** Attempts at the open + `VACUUM INTO` pair, the first one included. */
export const SNAPSHOT_ATTEMPTS = 3;

/** Pause between attempts — long enough for a scanner to let go of a
 *  seconds-old file, short enough that a real failure still fails promptly. */
const SNAPSHOT_RETRY_DELAY_MS = 250;

/** Injection points. Both default to the real thing; they exist because the
 *  retry cannot be provoked through the filesystem on every platform (Windows
 *  ignores POSIX mode bits, so a chmod-based injection would silently no-op and
 *  the test would pass without ever exercising the retry). */
export interface SnapshotOptions {
	/** How the source connection is opened. */
	readonly openSource?: (path: string) => Database;
	/** Pause between attempts, in ms. */
	readonly retryDelayMs?: number;
}

/**
 * Is this the failure a moment's wait might clear?
 *
 * SQLITE_CANTOPEN is what Windows produces when an antivirus scanner or the
 * search indexer still holds a handle on a file that was written seconds ago —
 * exactly the situation every pre-update snapshot is taken in. On Linux the
 * same message means something durable, so retrying costs one extra attempt and
 * changes no outcome.
 */
function isTransientOpenFailure(message: string): boolean {
	return /unable to open database file/i.test(message);
}

/** Open the source read-only and vacuum it into `destination`, retrying while
 *  the failure looks transient. Throws the last error once the budget is out. */
async function vacuumWithRetry(
	dbPath: string,
	destination: string,
	openSource: (path: string) => Database,
	retryDelayMs: number,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			const source = openSource(dbPath);
			try {
				source.run("VACUUM INTO ?", [destination]);
			} finally {
				source.close();
			}
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (attempt >= SNAPSHOT_ATTEMPTS || !isTransientOpenFailure(message)) throw err;
			// A torn attempt can leave a partial file behind, and VACUUM INTO
			// refuses to write over one — without this the retry would fail for a
			// completely different reason than the one being retried.
			await rm(destination, { force: true });
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
}

/** Where a pre-update snapshot for `version` lives under the data dir. */
export function snapshotPathFor(dataDir: string, version: string): string {
	// Version strings come from a release tag; keep the filename tame anyway.
	const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
	return join(dataDir, "backups", `pre-update-${safeVersion}.db`);
}

/**
 * Snapshot `dbPath` to `<dataDir>/backups/pre-update-<version>.db`.
 *
 * Never throws — the caller decides what a failure means. It reports `ok:
 * false` with a message rather than raising, so the update pipeline can treat
 * "no recovery point" as a soft abort.
 */
export async function snapshotDatabase(
	dbPath: string,
	dataDir: string,
	version: string,
	options: SnapshotOptions = {},
): Promise<SnapshotResult> {
	const destination = snapshotPathFor(dataDir, version);
	const openSource = options.openSource ?? ((path: string) => new Database(path, { readonly: true }));
	const retryDelayMs = options.retryDelayMs ?? SNAPSHOT_RETRY_DELAY_MS;

	try {
		if (!(await stat(dbPath).then(() => true, () => false))) {
			return {
				ok: false,
				path: null,
				bytes: 0,
				message: `No database found at ${dbPath} to snapshot.`,
			};
		}

		await mkdir(dirname(destination), { recursive: true });

		// VACUUM INTO refuses to overwrite. A snapshot for this exact version
		// already existing means a previous attempt at the same update got this
		// far; that snapshot is just as good a recovery point, so keep it.
		if (await stat(destination).then(() => true, () => false)) {
			const existing = await stat(destination);
			return { ok: true, path: destination, bytes: existing.size, message: null };
		}

		await vacuumWithRetry(dbPath, destination, openSource, retryDelayMs);

		const written = await stat(destination);
		return { ok: true, path: destination, bytes: written.size, message: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[update] pre-update database snapshot failed:", message);
		return {
			ok: false,
			path: null,
			bytes: 0,
			message: `Could not create a pre-update database backup: ${message}`,
		};
	}
}
