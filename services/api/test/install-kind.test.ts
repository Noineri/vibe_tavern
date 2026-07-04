import { describe, expect, it } from "bun:test";
import { classifyInstallKind, detectInstallKind } from "../src/domain/update/update-orchestrator.js";

const baseInput = {
	dockerEnv: undefined,
	isCompiled: true,
	platform: "linux" as const,
	execPath: "/home/user/vibe-tavern/vibe-tavern",
	hasInnoMarker: false,
};

describe("classifyInstallKind", () => {
	it("returns 'docker' when VIBE_TAVERN_DOCKER=1, even in a non-compiled (dev-like) runtime", () => {
		const result = classifyInstallKind({
			...baseInput,
			dockerEnv: "1",
			isCompiled: false,
		});
		expect(result).toBe("docker");
	});

	it("returns 'docker' when VIBE_TAVERN_DOCKER=1 even on Windows with Program Files path", () => {
		const result = classifyInstallKind({
			...baseInput,
			dockerEnv: "1",
			platform: "win32",
			execPath: "C:\\Program Files\\Vibe Tavern\\vibe-tavern.exe",
		});
		expect(result).toBe("docker");
	});

	it("returns 'dev' when not compiled and not docker", () => {
		const result = classifyInstallKind({ ...baseInput, isCompiled: false });
		expect(result).toBe("dev");
	});

	it("returns 'inno-setup' when the marker file is present, regardless of platform/path", () => {
		const result = classifyInstallKind({
			...baseInput,
			platform: "win32",
			execPath: "D:\\Apps\\Vibe Tavern\\vibe-tavern.exe",
			hasInnoMarker: true,
		});
		expect(result).toBe("inno-setup");
	});

	it("falls back to Program-Files path heuristic when marker is absent (legacy Inno installs)", () => {
		const result = classifyInstallKind({
			...baseInput,
			platform: "win32",
			execPath: "C:\\Program Files\\Vibe Tavern\\vibe-tavern.exe",
			hasInnoMarker: false,
		});
		expect(result).toBe("inno-setup");
	});

	it("returns 'standalone' for compiled Linux binary outside any install marker", () => {
		const result = classifyInstallKind({
			...baseInput,
			platform: "linux",
			execPath: "/home/user/Downloads/vibe-tavern",
		});
		expect(result).toBe("standalone");
	});

	it("returns 'standalone' for compiled Windows exe outside Program Files (zip extract)", () => {
		const result = classifyInstallKind({
			...baseInput,
			platform: "win32",
			execPath: "C:\\Users\\user\\Desktop\\Vibe Tavern\\Vibe Tavern.exe",
		});
		expect(result).toBe("standalone");
	});

	it("does not false-positive a zip extracted under Program Files when marker is absent — path heuristic wins by design (admin perms block self-update anyway)", () => {
		// Documents intentional trade-off: marker check is the primary signal,
		// path heuristic catches legacy Inno installs. A zip extracted to
		// Program Files will read as "inno-setup" — conservative (shows the
		// GH-fallback button instead of in-app update). Acceptable because
		// self-update against admin-protected dirs would fail regardless.
		const result = classifyInstallKind({
			...baseInput,
			platform: "win32",
			execPath: "C:\\Program Files\\VibeTavernZip\\Vibe Tavern.exe",
			hasInnoMarker: false,
		});
		expect(result).toBe("inno-setup");
	});
});

describe("detectInstallKind (live)", () => {
	it("returns 'docker' when VIBE_TAVERN_DOCKER=1 is set, regardless of compile state", () => {
		const prev = process.env.VIBE_TAVERN_DOCKER;
		process.env.VIBE_TAVERN_DOCKER = "1";
		try {
			expect(detectInstallKind()).toBe("docker");
		} finally {
			if (prev === undefined) delete process.env.VIBE_TAVERN_DOCKER;
			else process.env.VIBE_TAVERN_DOCKER = prev;
		}
	});

	it("returns 'dev' when neither docker nor compiled (the bun-run-dev case)", () => {
		const prev = process.env.VIBE_TAVERN_DOCKER;
		delete process.env.VIBE_TAVERN_DOCKER;
		try {
			expect(detectInstallKind()).toBe("dev");
		} finally {
			if (prev !== undefined) process.env.VIBE_TAVERN_DOCKER = prev;
		}
	});
});
