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
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SnapshotResult {
	readonly ok: boolean;
	readonly path: string | null;
	readonly bytes: number;
	readonly message: string | null;
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
): Promise<SnapshotResult> {
	const destination = snapshotPathFor(dataDir, version);

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

		const source = new Database(dbPath, { readonly: true });
		try {
			source.run("VACUUM INTO ?", [destination]);
		} finally {
			source.close();
		}

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
