import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Conditional requests for the static responses this process builds itself.
 *
 * Every static source is tagged here: the built asset directories on disk
 * (validated by size + mtime — `serveAssetFile`), and the two sources with no
 * file on disk to validate — the frontend baked into the single-file binary,
 * and index.html (hashed over their bytes — `weakEtag`). Without it no
 * conditional request can ever succeed: measured on the built bundle, a page
 * load pulls 10.0 MB over 5 requests, all of it again on every reload.
 *
 * The validator is weak (`W/"<bytes>-<hash>"`, hashed over the bytes about to
 * be sent), so it changes exactly when the content does. `no-cache` lets the
 * browser keep the copy but requires it to revalidate, which is what turns the
 * repeat load into a 304 with an empty body. `immutable`/`max-age` is
 * deliberately not used: not every file under /assets is content-hashed
 * (kokoro-worker.js and whisper-worker.js keep stable names), so a long
 * max-age would pin a stale worker in the browser cache after an update.
 */

const STATIC_CACHE_CONTROL = "no-cache";

export function weakEtag(body: Uint8Array | string): string {
	const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
	return `W/"${bytes.toString(16)}-${Bun.hash(body).toString(16)}"`;
}

/** RFC 9110 §13.1.2: `*` matches anything, otherwise any list member whose
 *  entity-tag equals ours (weak comparison — the `W/` prefix is ignored). */
function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
	if (!header) return false;
	const trimmed = header.trim();
	if (trimmed === "*") return true;
	const normalize = (value: string): string => value.trim().replace(/^W\//, "");
	const target = normalize(etag);
	return trimmed.split(",").some((candidate) => normalize(candidate) === target);
}

/**
 * Answer with 304 when the client already has this exact body, otherwise build
 * the response and tag it so the next request can be conditional.
 */
export function withStaticValidator(
	request: Request,
	etag: string,
	build: () => Response,
): Response {
	if (ifNoneMatchSatisfied(request.headers.get("If-None-Match"), etag)) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, "Cache-Control": STATIC_CACHE_CONTROL },
		});
	}
	const response = build();
	response.headers.set("ETag", etag);
	response.headers.set("Cache-Control", STATIC_CACHE_CONTROL);
	return response;
}

/** A file's validator from its metadata: hashing a 10 MB chunk on every
 *  request would cost more than the bytes it saves. Size + mtime changes on
 *  every rewrite, including a stable-named file rebuilt in place. */
function fileEtag(size: number, mtimeMs: number): string {
	return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

/**
 * Serve `<dir>/<rest of the path after prefix>` with a validator, resolving
 * the file on EVERY request. A Bun `{dir}` route did this natively but holds
 * the directory it opened at startup: the web build deletes and recreates
 * out/apps/web, so after a rebuild every asset 404ed until a restart while
 * index.html (read per request) already named the new chunks. Range requests
 * stay Bun's — a `Bun.file` body answers them with a 206 itself.
 */
export function serveAssetFile(dir: string, prefix: string, request: Request): Response {
	const notFound = (): Response => new Response("Not Found", { status: 404 });
	const pathname = new URL(request.url).pathname;
	if (!pathname.startsWith(`${prefix}/`)) return notFound();
	let relative: string;
	try {
		relative = decodeURIComponent(pathname.slice(prefix.length + 1));
	} catch {
		return notFound(); // malformed percent-encoding names no file
	}
	const root = resolve(dir);
	const filePath = resolve(root, relative);
	if (!filePath.startsWith(root + sep)) return notFound();
	const stats = statSync(filePath, { throwIfNoEntry: false });
	if (!stats?.isFile()) return notFound();
	const response = withStaticValidator(request, fileEtag(stats.size, stats.mtimeMs), () =>
		new Response(Bun.file(filePath)),
	);
	response.headers.set("Last-Modified", stats.mtime.toUTCString());
	return response;
}
