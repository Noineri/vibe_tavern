/**
 * Alias-resolution parity test (migration task 5.6).
 *
 * Proves that every `@vibe-tavern/*` specifier the web app depends on resolves
 * under Bun to the exact workspace TypeScript source it is supposed to — the
 * same set of aliases declared in `apps/web/tsconfig.json`.
 *
 * Package roots resolve through the workspace `exports`/`main` maps; the
 * subpath aliases (`db/codecs`, `domain/builtins`, `domain/script-safety`,
 * `test-fetch`) ride Bun's tsconfig-paths support (packages/domain ships no
 * `exports` map at all, so node-style subpath resolution could never serve
 * them) — this test pins both mechanisms: if a package's `exports` map drifts
 * from the tsconfig aliases, or any subpath stops pointing at its tsconfig
 * target, this fails.
 *
 * `@vibe-tavern/db/codecs` is asserted separately from `@vibe-tavern/db` on
 * purpose: the root barrel walks into `bun:sqlite`/`node:fs` (server-only),
 * while `/codecs` is the browser-safe leaf entry the web bundle is allowed to use.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

// apps/web/test -> vibe_tavern/ (monorepo root)
const ROOT = resolve(import.meta.dir, "../../..");

const EXPECTED: Record<string, string> = {
	"@vibe-tavern/api": "services/api/src/index.ts",
	"@vibe-tavern/api-contracts": "packages/api-contracts/src/index.ts",
	"@vibe-tavern/db": "packages/db/src/index.ts",
	"@vibe-tavern/db/codecs": "packages/db/src/codecs.ts",
	"@vibe-tavern/domain": "packages/domain/src/index.ts",
	"@vibe-tavern/domain/builtins": "packages/domain/src/builtin-experiences.ts",
	"@vibe-tavern/domain/script-safety": "packages/domain/src/script-safety.ts",
	"@vibe-tavern/import-export": "packages/import-export/src/index.ts",
	"@vibe-tavern/prompt-pipeline": "packages/prompt-pipeline/src/index.ts",
	"@vibe-tavern/test-fetch": "services/api/test/test-fetch-seam.ts",
};

describe("@vibe-tavern/* alias resolution under Bun", () => {
	for (const [specifier, relativeSource] of Object.entries(EXPECTED)) {
		test(`${specifier} -> ${relativeSource}`, () => {
			const resolved = Bun.resolveSync(specifier, import.meta.dir);
			expect(resolved).toBe(resolve(ROOT, relativeSource));
		});
	}
});
