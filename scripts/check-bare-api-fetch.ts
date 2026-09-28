/**
 * check-bare-api-fetch — mechanical guard for the API seam (2026-09-29 mobile outage).
 *
 * Every web→API request must go through `apiFetch` (apps/web/src/api/client.ts)
 * or a stream helper with `?token=` (appendTokenQuery). A bare `fetch("/api/…")`
 * sends no mobile Bearer token: on desktop loopback it passes silently, on a
 * LAN/mobile client it 401s — and a single 401 used to wipe the phone's valid
 * token into a "session revoked" loop. This script fails the check when a
 * bare /api fetch appears outside the seam, so the class stays closed by
 * tooling, not convention.
 *
 * Exemptions:
 *  - apps/web/src/api/client.ts — the seam itself.
 *  - *.test.* / *.spec.* files — tests mock fetch deliberately.
 *  - a file carrying the marker `// bare-fetch:allowed — <reason>`
 *    (streams that attach ?token= instead of a header).
 *
 * Run via `bun run check:bare-api-fetch` (also part of `bun run check`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_SRC = join(import.meta.dir, "..", "apps", "web", "src");
const SEAM_FILE = "api" + "\\client.ts";
const MARKER = "// bare-fetch:allowed";

// A fetch call that targets our API: `fetch("/api/…")` or `fetch(`/api/…`)`.
// Deliberately conservative — only flags fetches whose call target mentions
// an /api path literal, so foreign-origin fetches (CDNs, providers) never trip it.
const BARE_API_FETCH = /(?<![.\w])fetch\s*\(\s*["'`][^"'`]*\/api\//;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    yield full;
  }
}

const violations: Array<{ file: string; line: number; text: string }> = [];
let scanned = 0;

for (const file of walk(WEB_SRC)) {
  const rel = relative(join(import.meta.dir, ".."), file).replace(/\\/g, "/");
  const isTest = /\.(test|spec)\.[jt]sx?$/.test(rel);
  const isSeam = rel.replace(/\\/g, "/") === "apps/web/src/api/client.ts";
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const exemptFile = content.includes(MARKER);

  scanned++;
  if (isTest || isSeam || exemptFile || rel.endsWith(SEAM_FILE)) continue;

  lines.forEach((line, i) => {
    // Comment-only lines never count (mirrors test-hygiene).
    const stripped = line.replace(/\/\/.*$/, "");
    if (BARE_API_FETCH.test(stripped)) {
      violations.push({ file: rel, line: i + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(`Bare-API-fetch guard: FAIL (${scanned} files scanned)`);
  console.error("  Every /api fetch must go through apiFetch (apps/web/src/api/client.ts)");
  console.error("  — it attaches the mobile Bearer token and watches for session revocation.");
  console.error("  A bare fetch is green on desktop loopback and 401s every LAN/mobile client.");
  console.error("");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error("");
  console.error("  Fix: import { apiFetch } from \"…/api/client.js\" and call apiFetch(…) instead.");
  console.error("  Streams that cannot send headers use appendTokenQuery + a file marker:");
  console.error(`    ${MARKER} — <reason>`);
  process.exit(1);
}

console.log(`Bare-API-fetch guard: OK (${scanned} files scanned, seam intact)`);
