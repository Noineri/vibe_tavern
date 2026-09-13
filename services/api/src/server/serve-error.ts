/**
 * Last-resort error handler for `Bun.serve`.
 *
 * Hono's `onError` (app-factory.ts) catches anything a handler throws, so this
 * hook only sees the two failures that happen outside a handler:
 *
 *  - a response BODY that fails while being sent. Asset responses stream a
 *    `BunFile` straight from disk, so a file deleted between the stat and the
 *    send — the delete→fetch race — surfaces here as ENOENT. That is a 404, not
 *    a server fault: the resource is gone.
 *  - a throw from the `fetch` closure itself, before Hono is reached.
 *
 * Without the hook Bun answers with its built-in error page: a ~50 KB HTML
 * document that embeds the server's cwd and absolute source paths (measured on
 * 1.4.2). That must never reach a client.
 */

/** Node-style filesystem errors carry a string `code` (ENOENT, EISDIR, ...). */
function isFileSystemError(error: Error): error is Error & { code: string } {
	return "code" in error && typeof error.code === "string";
}

/** Codes that mean "the file backing this response body is not there anymore". */
const VANISHED_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

export function serveErrorResponse(tag: string, error: Error): Response {
	if (isFileSystemError(error) && VANISHED_CODES.has(error.code)) {
		console.error(`${tag} File vanished while sending a response: ${error.message}`);
		return Response.json({ error: "Not found" }, {
			status: 404,
			headers: { "Cache-Control": "no-store" },
		});
	}
	console.error(`${tag} Unhandled server error:`, error);
	return Response.json({ error: "Internal Server Error" }, {
		status: 500,
		headers: { "Cache-Control": "no-store" },
	});
}
