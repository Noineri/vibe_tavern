/**
 * Alias-resolution parity test (migration task 5.6).
 *
 * Proves that every `@vibe-tavern/*` specifier the web app depends on resolves
 * under Bun to the exact workspace TypeScript source it is supposed to — the
 * same set of aliases declared in `apps/web/tsconfig.json` / `tsconfig.typecheck.json`.
 *
 * Bun resolves these through the workspace `exports` maps (not tsconfig paths),
 * so this test is the runtime counterpart to the compiler's path aliases: if a
 * package's `exports` map drifts from the tsconfig aliases, or the `db/codecs`
 * browser-safe subpath stops pointing at the leaf codec entry, this fails.
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
	"@vibe-tavern/import-export": "packages/import-export/src/index.ts",
	"@vibe-tavern/prompt-pipeline": "packages/prompt-pipeline/src/index.ts",
};

describe("@vibe-tavern/* alias resolution under Bun", () => {
	for (const [specifier, relativeSource] of Object.entries(EXPECTED)) {
		test(`${specifier} -> ${relativeSource}`, () => {
			const resolved = Bun.resolveSync(specifier, import.meta.dir);
			expect(resolved).toBe(resolve(ROOT, relativeSource));
		});
	}
});
