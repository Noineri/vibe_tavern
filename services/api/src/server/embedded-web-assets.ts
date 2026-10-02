/**
 * The built frontend, baked into the standalone executable.
 *
 * Why the frontend is embedded at all: a user who extracted only
 * `vibe-tavern.exe` (or whose antivirus quarantined a single JS chunk) ended up
 * with a missing `web/assets/` directory and a permanently frozen splash
 * screen — the browser refused to execute an SPA bundle it could not fetch, and
 * the failure was silent. With the bundle inside the binary that failure mode
 * cannot happen: either the whole .exe is missing (loud) or everything is there.
 *
 * How it gets in: `scripts/build-standalone.ts` passes `out/apps/web` to the
 * compile step as an asset directory. Bun copies the tree into the executable
 * and exposes every file through `Bun.embeddedFiles` as a `Blob` whose `name`
 * is the asset-directory basename plus the path inside it — `web/index.html`,
 * `web/assets/index-Abc.js`, and so on. Nothing is generated into the source
 * tree, so there is no build-time mutation of a tracked file to undo.
 *
 * Outside a compiled binary (dev, tests, `bun run dev`) there are no embedded
 * files, the map is empty, and the server serves `web/` from disk instead.
 */

/** Basename of the asset directory handed to the compile step. */
const EMBED_DIR = "web";

/** An embedded file: a `Blob` that also carries the name Bun recorded for it. */
interface EmbeddedFile extends Blob {
	readonly name: string;
}

function isEmbeddedFile(blob: Blob): blob is EmbeddedFile {
	return "name" in blob && typeof blob.name === "string";
}

/**
 * URL pathname an embedded asset is served under, or `null` when the file does
 * not belong to the frontend tree.
 *
 * Bun records asset names with forward slashes on both Linux and Windows
 * (measured by running a compiled binary on each), but the name is a path and
 * the build machine's separator is not part of the contract, so both spellings
 * are accepted.
 */
export function embeddedWebUrlPath(name: string): string | null {
	const segments = name.split(/[\\/]/).filter((segment) => segment.length > 0);
	if (segments.length < 2 || segments[0] !== EMBED_DIR) return null;
	return `/${segments.slice(1).join("/")}`;
}

/**
 * Frontend files embedded in this executable, keyed by the URL pathname they
 * answer. Empty whenever the process is not a compiled binary.
 */
export function loadEmbeddedWebFiles(): ReadonlyMap<string, Blob> {
	const files = new Map<string, Blob>();
	if (!Bun.isStandaloneExecutable) return files;
	for (const blob of Bun.embeddedFiles) {
		if (!isEmbeddedFile(blob)) continue;
		const urlPath = embeddedWebUrlPath(blob.name);
		if (urlPath !== null) files.set(urlPath, blob);
	}
	return files;
}
