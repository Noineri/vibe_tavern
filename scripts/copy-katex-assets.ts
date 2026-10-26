/**
 * Copies the vendored KaTeX stylesheet + woff2 fonts into `apps/web/public/katex/`.
 *
 * The agent shell lazy-loads math rendering (see `apps/web/src/lib/markdown-math.tsx`):
 * the JS (`remark-math` + `rehype-katex`) arrives as a dynamic-import chunk and the
 * stylesheet as a same-origin `<link>`, so neither lands in the initial bundle.
 * Bun inlines `url()` fonts as base64 into bundled CSS, which would bloat the entry
 * CSS — hence files on disk served from `public/` (dev server + prod `cp` both serve
 * it with no extra wiring) instead of a bundled CSS import.
 *
 * Only woff2 is copied: every modern browser picks the first supported `@font-face`
 * source (woff2) and never requests the woff/ttf fallbacks, so they would be dead
 * weight. The CSS itself is copied byte-identical — no URL rewriting to drift.
 *
 * Re-run after every `katex` upgrade (`bun run scripts/copy-katex-assets.ts`
 * from the repo root). `public/katex/VERSION` stamps the copied version; the
 * `katex-assets` test fails when it drifts from the installed package.
 */
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "apps/web/node_modules/katex/dist");
const DEST = join(ROOT, "apps/web/public/katex");
const FONTS_DEST = join(DEST, "fonts");

const version: string = (await Bun.file(join(DIST, "..", "package.json")).json()).version;

await rm(DEST, { recursive: true, force: true });
await mkdir(FONTS_DEST, { recursive: true });

await copyFile(join(DIST, "katex.min.css"), join(DEST, "katex.min.css"));

const fonts = (await readdir(join(DIST, "fonts"))).filter((f) => f.endsWith(".woff2")).sort();
for (const font of fonts) {
	await copyFile(join(DIST, "fonts", font), join(FONTS_DEST, font));
}

await writeFile(join(DEST, "VERSION"), `${version}\n`);

console.log(`katex ${version}: katex.min.css + ${fonts.length} woff2 fonts → apps/web/public/katex/`);
