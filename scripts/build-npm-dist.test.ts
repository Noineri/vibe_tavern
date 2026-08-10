import { describe, expect, it } from "bun:test";
import { manifest } from "./build-npm-dist.js";

/**
 * Pins the two manifest fields whose failure mode is a SILENT bad publish.
 *
 * Both were found by publishing to a local registry, not by review: `npm pack`
 * and `npm publish --dry-run` do not fail on either — one warns, the other only
 * misbehaves outside CI — so nothing short of a real publish surfaces them.
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

	it("stamps the version it is given", () => {
		expect(manifest("9.8.7").version).toBe("9.8.7");
	});
});
