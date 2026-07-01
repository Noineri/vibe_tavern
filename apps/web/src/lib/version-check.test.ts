import { test, expect, describe } from "bun:test";
import { parseSemver, compareSemver } from "./version-check.js";

describe("parseSemver", () => {
	test("parses plain semver", () => {
		expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
	});

	test("strips leading v", () => {
		expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
	});

	test("strips prerelease suffix", () => {
		expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
		expect(parseSemver("v1.2.3-rc.2+build.5")).toEqual([1, 2, 3]);
	});

	test("handles multi-digit components", () => {
		expect(parseSemver("10.20.30")).toEqual([10, 20, 30]);
		expect(parseSemver("1.0.0")).toEqual([1, 0, 0]);
	});

	test("returns null on garbage", () => {
		expect(parseSemver("garbage")).toBeNull();
		expect(parseSemver("1")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
		expect(parseSemver("v")).toBeNull();
	});

	test("does not match non-numeric components", () => {
		expect(parseSemver("a.b.c")).toBeNull();
		expect(parseSemver("vX.Y.Z")).toBeNull();
	});
});

describe("compareSemver", () => {
	test("equal versions return 0", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
	});

	test("major difference dominates", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
	});

	test("minor difference dominates patch", () => {
		expect(compareSemver("1.3.0", "1.2.99")).toBeGreaterThan(0);
		expect(compareSemver("1.2.99", "1.3.0")).toBeLessThan(0);
	});

	test("patch difference", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
		expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
	});

	test("ignores prerelease tags", () => {
		// 1.0.0-beta vs 1.0.0 — parser strips the suffix, treats as equal.
		// This is intentional: we only signal an update when major.minor.patch
		// strictly increases, so a prerelease of the same triple does NOT
		// notify.
		expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(0);
	});

	test("returns 0 when either side is unparseable", () => {
		// The safe default is "equal" — suppresses a spurious update
		// notification rather than firing one on garbage input.
		expect(compareSemver("garbage", "1.0.0")).toBe(0);
		expect(compareSemver("1.0.0", "garbage")).toBe(0);
		expect(compareSemver("garbage", "garbage")).toBe(0);
	});

	test("typical update-check scenario", () => {
		// Running 1.0.0, latest is 1.0.1 → update available
		expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
		// Running 1.0.0, latest is 1.0.0 → no update
		expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
		// Running 1.0.0, latest is 0.9.9 → no update (downgrade)
		expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
	});
});
