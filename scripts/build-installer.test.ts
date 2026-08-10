import { expect, test } from "bun:test";
import { FAST_COMPRESSION_FLAG, isccArgs } from "./build-installer.js";

const ISCC = "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe";
const ROOT = "D:\\a\\vibe_tavern\\vibe_tavern";
const ISS = "D:\\a\\vibe_tavern\\vibe_tavern\\installer\\vibe-tavern.iss";

test("ships the installer at the compression declared in the .iss", () => {
	// The release artifact is what users download; nothing on the command line
	// may weaken it, so a default build passes no compression override at all
	// and the .iss `#if !Defined` fallbacks (lzma2/ultra64, solid) apply.
	const args = isccArgs(ISCC, ROOT, "1.1.2", ISS, false);

	expect(args).toEqual([ISCC, `/DProjectRoot=${ROOT}`, "/DAppVersion=1.1.2", ISS]);
	expect(args.join(" ")).not.toContain("Compression");
});

test("drops compression entirely only when asked", () => {
	// CI throws the installer away and only needs to know it compiles; ultra64
	// over a solid block costs ~95s of a ~108s step for an artifact nobody
	// downloads. The script still parses, every [Files] entry still resolves.
	const args = isccArgs(ISCC, ROOT, "1.1.2", ISS, true);

	expect(args).toEqual([
		ISCC,
		`/DProjectRoot=${ROOT}`,
		"/DAppVersion=1.1.2",
		"/DCompression=none",
		"/DSolidCompression=no",
		ISS,
	]);
});

test("keeps every /D value a bare identifier", () => {
	// ISPP evaluates /D values as expressions, so `lzma2/fast` is a division and
	// `lzma2/ultra64` would be too. Only the .iss may spell a slashed level; the
	// command line must not, or ISCC fails on a line nobody edited.
	const overrides = isccArgs(ISCC, ROOT, "1.1.2", ISS, true).filter((arg) => arg.startsWith("/DCompression") || arg.startsWith("/DSolidCompression"));

	expect(overrides.length).toBe(2);
	for (const override of overrides) {
		expect(override.split("=")[1]).toMatch(/^[A-Za-z0-9_]+$/);
	}
});

test("keeps the script path last so ISCC reads every /D that precedes it", () => {
	// ISCC takes the script as its trailing positional; a /D after it is not a
	// define, it is a second script name.
	for (const fast of [false, true]) {
		expect(isccArgs(ISCC, ROOT, "1.1.2", ISS, fast).at(-1)).toBe(ISS);
	}
});

test("names the flag the workflow actually passes", () => {
	// ci.yml spells this literally; a rename here without one there silently
	// restores the slow path instead of failing.
	expect(FAST_COMPRESSION_FLAG).toBe("--fast-compression");
});
