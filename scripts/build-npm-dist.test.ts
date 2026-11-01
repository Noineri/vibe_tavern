import { describe, expect, it } from "bun:test";
import { hasBakedModuleFilename, manifest, rewriteBakedModuleFilenames } from "./build-npm-dist.js";

/**
 * Pins consumer- and publisher-visible manifest contracts.
 *
 * The bin and publishConfig failures were found by publishing to a local
 * registry: `npm pack` and `npm publish --dry-run` do not fail on either —
 * one warns, the other only misbehaves outside CI.
 */

describe("npm manifest", () => {
	it("declares the bin without a './' prefix", () => {
		// npm's normalizer DELETES a bin entry whose path starts with "./",
		// publishing a package with no launcher while exiting 0. `npm pack`
		// does not normalize, so an install from the local tarball still works
		// and hides it.
		const bin = manifest("1.2.3").bin;
		expect(bin).toEqual({ "vibe-tavern": "vibe-tavern.js" });
		for (const target of Object.values(bin)) {
			expect(target.startsWith("./")).toBe(false);
		}
	});

	it("does not bake provenance into publishConfig", () => {
		// Provenance describes the publishing environment, not the package.
		// Setting it here makes every publish outside GitHub Actions fail with
		// "Automatic provenance generation not supported for provider: null".
		// release-npm.yml passes --provenance on the command line instead.
		expect(manifest("1.2.3").publishConfig).toEqual({ access: "public" });
	});

	it("points repository.url at the repo trusted publishing is configured for", () => {
		// npm validates this against the OIDC claim; a mismatch fails the publish.
		expect(manifest("1.2.3").repository.url).toBe("git+https://github.com/Noineri/vibe_tavern.git");
	});

	it("ships no dependencies — everything is bundled", () => {
		expect("dependencies" in manifest("1.2.3")).toBe(false);
	});

	it("requires the Bun version used by the shipped runtime APIs", () => {
		expect(manifest("1.2.3").engines).toEqual({ bun: ">=1.4.4" });
	});

	it("stamps the version it is given", () => {
		expect(manifest("9.8.7").version).toBe("9.8.7");
	});

	// hygiene:allow-abs-path-inputs — the rewrite samples quote absolute
	// build-machine paths as attack data: a baked path literal IS the defect
	// this contract pins (CI linux build → Windows runtime, 2026-10-27).
	describe("bundled __filename rewrite", () => {
		it("rewrites a baked Windows-path declaration to the runtime module path", () => {
			// Byte shape taken from a real out/npm-dist/vibe-tavern.js bundle:
			// the wrapper declares `var __filename="…"` with the BUILD machine's
			// absolute path, backslash-escaped inside the JS string literal.
			const bundle =
				'var lK=ZI(function(iR,nK){var __filename="N:\\janitor_characters\\vibe_tavern\\node_modules\\lib\\index.js";})();';
			expect(rewriteBakedModuleFilenames(bundle)).toBe(
				"var lK=ZI(function(iR,nK){var __filename=import.meta.path;})();",
			);
		});

		it("rewrites a baked POSIX-path declaration (cross-OS CI artifact)", () => {
			const bundle = 'var __filename="/home/runner/work/vibe_tavern/lib/index.js";';
			expect(rewriteBakedModuleFilenames(bundle)).toBe("var __filename=import.meta.path;");
		});

		it("leaves bare __filename references and similar declarations untouched", () => {
			const bundle =
				'new URL("file:"+__filename).href;var fileName="x.js";var __dirname="/home/runner/lib";';
			expect(rewriteBakedModuleFilenames(bundle)).toBe(bundle);
		});

		it("is a no-op on an already-rewritten bundle", () => {
			const bundle = "var __filename=import.meta.path;";
			expect(rewriteBakedModuleFilenames(bundle)).toBe(bundle);
			expect(hasBakedModuleFilename(bundle)).toBe(false);
		});

		it("detects baked declarations the rewrite did not cover", () => {
			expect(hasBakedModuleFilename('var __filename="/opt/host/lib/index.js";')).toBe(true);
			expect(hasBakedModuleFilename(rewriteBakedModuleFilenames('var __filename="/opt/host/lib/index.js";'))).toBe(false);
		});
	});
});
