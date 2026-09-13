/**
 * Conditional requests for the static responses this process builds itself.
 *
 * Bun's `{dir}` routes attach an `ETag`/`Last-Modified` to files on disk and
 * answer `If-None-Match` with a 304. The two static paths that have no file on
 * disk to validate — the frontend baked into the single-file binary, and the
 * index.html read into memory at startup — have to do it here. Without it no
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
