import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { rewriteIndexHtml } from "../apps/web/bun-plugin-web-assets.js";

const ROOT = resolve(import.meta.dir, "..");
const INDEX_HTML = join(ROOT, "apps", "web", "index.html");

// Regression pin for the Windows standalone build failure ("Could not resolve:
// /logo-256.png"). Bun's HTML bundler resolves <link href>/<script src> BEFORE
// the plugin's onResolve runs; a root-relative "/logo-256.png" is absolutized
// against cwd. On POSIX the leading-slash path still reaches onResolve (marked
// external, kept verbatim) so the build passes; on Windows it becomes a
// drive-rooted path that misses the /^\// filter, default resolution runs, and
// the build fails. The fix relativizes favicon/script hrefs in rewriteIndexHtml
// so Bun bundles them natively on every platform.
//
// This pins the pure transform against the real index.html (a full-graph
// Bun.build can't be used here — the bun:test runtime doesn't resolve the app's
// workspace deps like zod/@vibe-tavern/domain, so it fails for unrelated
// reasons). If the markup regains a leading-slash logo/favicon/src href, this
// catches it deterministically on every platform.
test("rewriteIndexHtml leaves no cwd-resolved leading-slash asset href", async () => {
	const source = await Bun.file(INDEX_HTML).text();

	// Guard: the source must actually contain the hrefs we claim to fix, or the
	// assertions below would pass vacuously if the markup were restructured.
	expect(source).toMatch(/(?:href|src)="\/(?:logo|favicon)/);
	expect(source).toMatch(/src="\/src\//);

	const rewritten = rewriteIndexHtml(source);

	// No favicon/logo or src bundle entry may survive as a leading-slash path —
	// that is exactly what Bun's HTML bundler would resolve against cwd.
	expect(rewritten).not.toMatch(/(?:href|src)="\/(?:logo|favicon)/);
	expect(rewritten).not.toMatch(/src="\/src\//);

	// The rewrite is surgical: it must not touch other root-relative URLs (e.g.
	// a manifest or an anchor), only the bundler-facing asset references.
	const logoRefs = [...rewritten.matchAll(/href="([^"]*logo[^"]*)"/g)].map((m) => m[1]);
	expect(logoRefs.length).toBeGreaterThan(0);
	for (const ref of logoRefs) {
		expect(ref.startsWith("/")).toBe(false);
		expect(ref.startsWith("./public/")).toBe(true);
	}
});
