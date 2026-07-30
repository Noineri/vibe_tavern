/**
 * Pre-update checks that refuse an update we already know cannot finish.
 *
 * The expensive failure mode this prevents: download 63-76 MB, extract ~190 MB
 * beside it, and only then run out of room — mid-swap, with the install in a
 * mixed state. Checking first turns that into a soft refusal that names the
 * numbers.
 */

import { statfs } from "node:fs/promises";

/**
 * The extracted tree is roughly 3x the compressed archive (measured: 65 MB
 * tar.gz -> 192 MB, 79 MB zip -> 215 MB). Both the archive and the extracted
 * copy live under the install dir at the same time, and the previous install
 * is still there too, so the requirement is archive + 3x archive + headroom.
 */
const EXTRACTED_SIZE_RATIO = 3;

/** Slack for the backup directory, logs, and general "do not fill the disk". */
const HEADROOM_BYTES = 256 * 1024 * 1024;

export interface FreeSpaceResult {
	readonly ok: boolean;
	readonly requiredBytes: number;
	readonly availableBytes: number | null;
	/** Present when `ok` is false; ready to show to a user. */
	readonly message: string | null;
}

export function estimateRequiredBytes(archiveBytes: number): number {
	// A NaN or negative size (an asset whose size GitHub did not report, or a
	// hand-built release object) must degrade to "only headroom required", never
	// to a NaN comparison that refuses every update.
	const archive = Number.isFinite(archiveBytes) && archiveBytes > 0 ? archiveBytes : 0;
	return archive + archive * EXTRACTED_SIZE_RATIO + HEADROOM_BYTES;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Check that `installDir`'s volume can hold the archive plus its extracted
 * form plus headroom.
 *
 * Never throws. If the free space cannot be determined (statfs unsupported on
 * some exotic mount, or the path vanished), the result is `ok: true` with a
 * null `availableBytes` — an unknown answer must not block an update that
 * would otherwise have worked.
 */
export async function checkFreeSpace(
	installDir: string,
	archiveBytes: number,
): Promise<FreeSpaceResult> {
	const requiredBytes = estimateRequiredBytes(archiveBytes);

	let availableBytes: number | null = null;
	try {
		const fsStats = await statfs(installDir);
		const blockSize = Number(fsStats.bsize);
		const availableBlocks = Number(fsStats.bavail);
		if (Number.isFinite(blockSize) && Number.isFinite(availableBlocks)) {
			availableBytes = blockSize * availableBlocks;
		}
	} catch (err) {
		console.error(
			"[update-preflight] could not determine free space:",
			err instanceof Error ? err.message : String(err),
		);
	}

	if (availableBytes === null || availableBytes >= requiredBytes) {
		return { ok: true, requiredBytes, availableBytes, message: null };
	}

	return {
		ok: false,
		requiredBytes,
		availableBytes,
		message:
			`Not enough free space to install the update. ` +
			`Need about ${formatBytes(requiredBytes)}, but only ${formatBytes(availableBytes)} ` +
			`is available on the drive holding ${installDir}.`,
	};
}
