/**
 * Characterization pins for the updater's release-metadata layer.
 *
 * These pin the behavior that later waves of SELF_UPDATE_HARDENING_PLAN must
 * preserve while the pipeline around them is rewritten: GitHub JSON parsing +
 * asset selection, version comparison, and SHA256SUMS.txt matching.
 *
 * Written against the host platform's asset suffix, so the archive-selection
 * assertions read `-linux.tar.gz` on CI/dev Linux and `-windows.zip` on Windows.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { compareVersions, parseRelease, verifyChecksum } from "../src/server/updater.js";

const ARCHIVE_SUFFIX = process.platform === "win32" ? "-windows.zip" : "-linux.tar.gz";

/** A real-shaped `/releases/latest` payload for the given tag. */
function releaseJson(tag: string, overrides: Record<string, unknown> = {}) {
	const v = tag.replace(/^v/, "");
	return {
		tag_name: tag,
		name: `Vibe Tavern ${tag}`,
		body: "## What's new\r\n- Faster startup\r\n",
		draft: false,
		prerelease: false,
		assets: [
			asset(`Vibe-Tavern-v${v}-linux.tar.gz`),
			asset(`Vibe-Tavern-v${v}-windows.zip`),
			asset(`Vibe-Tavern-v${v}-windows-setup.exe`),
			asset(`Vibe-Tavern-v${v}-android.apk`),
			asset("SHA256SUMS.txt"),
		],
		...overrides,
	};
}

function asset(name: string) {
	return {
		name,
		browser_download_url: `https://github.com/Noineri/vibe_tavern/releases/download/v9.9.9/${name}`,
		size: 1234,
		content_type: "application/octet-stream",
	};
}

describe("parseRelease", () => {
	it("extracts tag, version (leading v stripped), notes, and the platform archive + sums assets", () => {
		const parsed = parseRelease(releaseJson("v1.4.2"));
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.tag).toBe("v1.4.2");
		expect(parsed.version).toBe("1.4.2");
		expect(parsed.releaseNotes).toBe("## What's new\r\n- Faster startup\r\n");
		expect(parsed.archiveAsset.name).toBe(`Vibe-Tavern-v1.4.2${ARCHIVE_SUFFIX}`);
		expect(parsed.sumsAsset.name).toBe("SHA256SUMS.txt");
	});

	it("never selects the android .apk or the windows setup .exe as the archive asset", () => {
		const parsed = parseRelease(releaseJson("v1.4.2"));
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.archiveAsset.name.endsWith(".apk")).toBe(false);
		expect(parsed.archiveAsset.name.endsWith("-setup.exe")).toBe(false);
	});

	it("keeps a tag that has no leading v as-is", () => {
		const parsed = parseRelease(releaseJson("2.0.0"));
		expect(parsed?.tag).toBe("2.0.0");
		expect(parsed?.version).toBe("2.0.0");
	});

	it("defaults releaseNotes to an empty string when body is absent or not a string", () => {
		expect(parseRelease(releaseJson("v1.0.0", { body: null }))?.releaseNotes).toBe("");
		const noBody = releaseJson("v1.0.0");
		delete (noBody as { body?: unknown }).body;
		expect(parseRelease(noBody)?.releaseNotes).toBe("");
	});

	it("skips malformed asset entries instead of failing the whole parse", () => {
		const parsed = parseRelease(
			releaseJson("v1.0.0", {
				assets: [
					null,
					"not-an-object",
					{ name: 42, browser_download_url: "https://example.test/x" },
					{ name: "missing-url.tar.gz" },
					asset(`Vibe-Tavern-v1.0.0${ARCHIVE_SUFFIX}`),
					asset("SHA256SUMS.txt"),
				],
			}),
		);
		expect(parsed?.archiveAsset.name).toBe(`Vibe-Tavern-v1.0.0${ARCHIVE_SUFFIX}`);
	});

	it("returns null when the payload is not an object", () => {
		expect(parseRelease(null)).toBeNull();
		expect(parseRelease("v1.0.0")).toBeNull();
		expect(parseRelease(42)).toBeNull();
	});

	it("returns null when tag_name is missing or not a string", () => {
		const noTag = releaseJson("v1.0.0");
		delete (noTag as { tag_name?: unknown }).tag_name;
		expect(parseRelease(noTag)).toBeNull();
		expect(parseRelease(releaseJson("v1.0.0", { tag_name: 1 }))).toBeNull();
	});

	it("returns null when assets is not an array", () => {
		expect(parseRelease(releaseJson("v1.0.0", { assets: {} }))).toBeNull();
	});

	it("returns null when the platform archive asset is absent", () => {
		expect(
			parseRelease(releaseJson("v1.0.0", { assets: [asset("SHA256SUMS.txt")] })),
		).toBeNull();
	});

	it("returns null when SHA256SUMS.txt is absent", () => {
		expect(
			parseRelease(
				releaseJson("v1.0.0", { assets: [asset(`Vibe-Tavern-v1.0.0${ARCHIVE_SUFFIX}`)] }),
			),
		).toBeNull();
	});
});

describe("compareVersions", () => {
	it("orders by numeric segment, most significant first", () => {
		expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
		expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
		expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
		expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
	});

	it("treats equal versions as 0", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});

	it("ignores a leading v on either side", () => {
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.2.3", "v1.2.4")).toBeLessThan(0);
	});

	it("pads missing segments with 0", () => {
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
		expect(compareVersions("1", "1.0.0")).toBe(0);
	});

	it("coerces non-numeric segments to 0 (the documented lossy behavior)", () => {
		// "dev" -> parseInt("dev") is NaN -> `|| 0` -> 0, so the dev build reads
		// as 0.0.0 and every real release is an update. This is what makes the
		// badge work in dev builds.
		expect(compareVersions("dev", "0.0.0")).toBe(0);
		expect(compareVersions("dev", "1.0.0")).toBeLessThan(0);
	});

	it("mis-orders prereleases — pinned as the known-lossy contract, not as desirable", () => {
		// "1.2.3-beta.1" splits on "." into ["1","2","3-beta","1"], so parseInt
		// yields [1,2,3,1] and the prerelease sorts ABOVE its own release.
		// Nothing in the product publishes prereleases, so this is inert today;
		// pinned so a later rewrite notices if it changes.
		expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBeGreaterThan(0);
	});
});

describe("verifyChecksum", () => {
	let dir = "";
	let archivePath = "";
	const contents = "vibe-tavern release archive bytes";
	const digest = createHash("sha256").update(contents).digest("hex");

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vt-sums-"));
		archivePath = join(dir, "archive.tar.gz");
		await writeFile(archivePath, contents);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("accepts a matching sha256sum-format entry (two spaces, binary marker)", async () => {
		const sums = [
			`${"0".repeat(64)}  SHA256SUMS-decoy.txt`,
			`${digest}  Vibe-Tavern-v1.0.0-linux.tar.gz`,
		].join("\n");
		await verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums);
	});

	it("accepts an uppercase expected hash (comparison is case-insensitive)", async () => {
		const sums = `${digest.toUpperCase()}  Vibe-Tavern-v1.0.0-linux.tar.gz`;
		await verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums);
	});

	it("tolerates blank lines and surrounding whitespace", async () => {
		const sums = `\n\n   ${digest}  Vibe-Tavern-v1.0.0-linux.tar.gz   \n\n`;
		await verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums);
	});

	it("matches the filename column exactly — a name that is a suffix of another must not cross-match", async () => {
		// This is the real shape of our own SHA256SUMS.txt: the zip's name is a
		// suffix of nothing, but `-windows.zip` IS a suffix of a line ending in
		// `Vibe-Tavern-v1.0.0-windows.zip` while `...-setup.exe` lines share the
		// same prefix. The dangerous direction is a short name matching a longer
		// line, so pin that the SHORT name does not pick up the LONG line.
		const wrong = "9".repeat(64);
		const sums = [
			`${wrong}  prefix-Vibe-Tavern-v1.0.0-linux.tar.gz`,
			`${digest}  Vibe-Tavern-v1.0.0-linux.tar.gz`,
		].join("\n");

		// The decoy line is listed first and the old `endsWith` scan would have
		// stopped there and compared against the wrong digest.
		await verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums);
	});

	it("does not match a longer filename when only a shorter one is present", async () => {
		const sums = `${digest}  Vibe-Tavern-v1.0.0-windows.zip`;
		await expect(
			verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-windows-setup.exe", sums),
		).rejects.toThrow("No checksum entry for Vibe-Tavern-v1.0.0-windows-setup.exe");
	});

	it("accepts the binary-mode marker sha256sum writes as `<hash> *<name>`", async () => {
		const sums = `${digest} *Vibe-Tavern-v1.0.0-linux.tar.gz`;
		await verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums);
	});

	it("throws when no entry names the archive", async () => {
		const sums = `${digest}  some-other-file.zip`;
		await expect(
			verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums),
		).rejects.toThrow("No checksum entry for Vibe-Tavern-v1.0.0-linux.tar.gz");
	});

	it("throws when the hash column is not a 64-char hex digest", async () => {
		const sums = `notahash  Vibe-Tavern-v1.0.0-linux.tar.gz`;
		await expect(
			verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums),
		).rejects.toThrow("Malformed checksum line");
	});

	it("throws with both digests when the file does not match", async () => {
		const wrong = "1".repeat(64);
		const sums = `${wrong}  Vibe-Tavern-v1.0.0-linux.tar.gz`;
		await expect(
			verifyChecksum(archivePath, "Vibe-Tavern-v1.0.0-linux.tar.gz", sums),
		).rejects.toThrow(/Checksum mismatch[\s\S]*expected: 1{64}[\s\S]*actual:\s+[0-9a-f]{64}/);
	});
});
