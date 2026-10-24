/**
 * KaTeX asset sync (owner follow-up 2026-10-24, item 2).
 *
 * The agent shell lazy-loads the vendored KaTeX stylesheet from
 * `apps/web/public/katex/` (see `markdown-math.tsx` and
 * `scripts/copy-katex-assets.ts`). This pins the vendored copy to the installed
 * `katex` package: after every katex upgrade re-run the copy script, or this
 * fails. It also pins that every woff2 font the stylesheet references exists —
 * a missing file would silently degrade formula rendering to fallback fonts.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const WEB_DIR = join(import.meta.dir, "..", "..");
const KATEX_DIR = join(WEB_DIR, "public", "katex");

describe("katex-assets — vendored copy matches the installed package", () => {
  it("VERSION stamps the installed katex version", async () => {
    const stamped = (await Bun.file(join(KATEX_DIR, "VERSION")).text()).trim();
    const installed = (await Bun.file(join(WEB_DIR, "node_modules", "katex", "package.json")).json()).version as string;
    expect(stamped).toBe(installed);
  });

  it("the stylesheet exists and every referenced woff2 font ships with it", async () => {
    const css = await Bun.file(join(KATEX_DIR, "katex.min.css")).text();
    expect(css.length).toBeGreaterThan(0);
    const refs = [...css.matchAll(/url\((["']?)(fonts\/[^)"']+\.woff2)\1\)/g)].map((m) => m[2]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      expect(await Bun.file(join(KATEX_DIR, ref)).exists()).toBe(true);
    }
  });
});
