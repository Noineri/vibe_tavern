import { stat } from "node:fs/promises";

/**
 * Stat-based existence check that works for files and directories.
 * `Bun.file(path).exists()` is file-only and previously regressed dev:api
 * startup when used for directory checks.
 */
export async function pathExists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}
