/**
 * Shared version resolver for build scripts.
 *
 * Reads version from the VERSION env var (set by CI from git tag),
 * falling back to the root package.json .version field for local dev.
 */

import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const VERSION: string =
	process.env.VERSION ??
	((await Bun.file(join(ROOT, "package.json")).json()).version as string) ??
	"0.0.0-dev";
