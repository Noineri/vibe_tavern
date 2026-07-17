#!/usr/bin/env bun

import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) {
	const key = Bun.argv[index];
	const value = Bun.argv[index + 1];
	if (!key?.startsWith("--") || !value) {
		throw new Error(`Expected --name value arguments; received ${key ?? "<missing>"}`);
	}
	args.set(key.slice(2), value);
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const bindAddress = args.get("bind") ?? "0.0.0.0";
const port = Number(args.get("port") ?? "8791");
const baseVersion = args.get("base-version") ?? "0.0.0";
const updateVersion = args.get("update-version") ?? "0.0.1";
const baseVersionCode = Number(args.get("base-code") ?? "1");
const updateVersionCode = Number(args.get("update-code") ?? "2");
const skipBuild = args.get("skip-build") === "true";

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a valid TCP port");
if (!versionPattern.test(baseVersion) || !versionPattern.test(updateVersion)) {
	throw new Error("--base-version and --update-version must use X.Y.Z");
}
if (!Number.isInteger(baseVersionCode) || !Number.isInteger(updateVersionCode) || updateVersionCode <= baseVersionCode) {
	throw new Error("The update version code must be an integer greater than the base version code");
}

function privateLanAddress(): string | null {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			const octets = address.address.split(".").map(Number);
			const isPrivate = octets[0] === 10 ||
				(octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
				(octets[0] === 192 && octets[1] === 168);
			if (isPrivate) return address.address;
		}
	}
	return null;
}

const publicHost = args.get("host") ?? privateLanAddress();
if (!publicHost) throw new Error("Could not infer a private LAN IPv4 address; pass --host 192.168.x.x");

const scriptDirectory = import.meta.dir;
const androidRoot = resolve(scriptDirectory, "..");
const buildDirectory = join(androidRoot, "build", "local-update");
const gradleOutput = join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const baseApk = join(buildDirectory, `Vibe-Tavern-v${baseVersion}-android-base.apk`);
const updateAssetName = `Vibe-Tavern-v${updateVersion}-android.apk`;
const updateApk = join(buildDirectory, updateAssetName);
const origin = `http://${publicHost}:${port}`;
const releasePath = "/repos/Noineri/vibe_tavern/releases/latest";
const releaseUrl = `${origin}${releasePath}`;

async function runGradle(versionName: string, versionCode: number): Promise<void> {
	const gradleArguments = [
		"assembleDebug",
		`-PVIBE_UPDATE_TEST_URL=${releaseUrl}`,
		`-PVIBE_UPDATE_TEST_VERSION_NAME=${versionName}`,
		`-PVIBE_UPDATE_TEST_VERSION_CODE=${versionCode}`,
	];
	const command = process.platform === "win32"
		? ["cmd.exe", "/d", "/c", "gradlew.bat", ...gradleArguments]
		: ["./gradlew", ...gradleArguments];
	const child = Bun.spawn(command, {
		cwd: androidRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`Gradle failed for v${versionName} with exit code ${exitCode}`);
}

async function copyBuiltApk(destination: string): Promise<void> {
	const source = Bun.file(gradleOutput);
	if (!(await source.exists())) throw new Error(`Gradle did not produce ${gradleOutput}`);
	await Bun.write(destination, source);
}

if (!skipBuild) {
	console.log(`Building base debug APK v${baseVersion} (${baseVersionCode})…`);
	await runGradle(baseVersion, baseVersionCode);
	await copyBuiltApk(baseApk);

	console.log(`\nBuilding update debug APK v${updateVersion} (${updateVersionCode})…`);
	await runGradle(updateVersion, updateVersionCode);
	await copyBuiltApk(updateApk);
}

const updateFile = Bun.file(updateApk);
const baseFile = Bun.file(baseApk);
if (!(await updateFile.exists()) || !(await baseFile.exists())) {
	throw new Error("Local updater APKs are missing; run once without --skip-build true");
}
const releaseJson = JSON.stringify({
	tag_name: `v${updateVersion}`,
	name: `Vibe Tavern v${updateVersion} — local LAN fixture`,
	body: "Local same-LAN updater test. This is not a public GitHub release.",
	html_url: origin,
	draft: false,
	prerelease: false,
	assets: [{
		name: updateAssetName,
		browser_download_url: `${origin}/${updateAssetName}`,
		size: updateFile.size,
	}],
});

Bun.serve({
	hostname: bindAddress,
	port,
	fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (pathname === releasePath) {
			return new Response(releaseJson, {
				headers: { "Content-Type": "application/json; charset=utf-8" },
			});
		}
		if (pathname === `/${updateAssetName}`) {
			return new Response(updateFile, {
				headers: { "Content-Type": "application/vnd.android.package-archive" },
			});
		}
		if (pathname === "/base.apk") {
			return new Response(baseFile, {
				headers: { "Content-Type": "application/vnd.android.package-archive" },
			});
		}
		return new Response("Not found", { status: 404 });
	},
});

console.log(`\nLocal Android updater fixture is listening on ${bindAddress}:${port}`);
console.log(`Phone-visible release API: ${releaseUrl}`);
console.log(`1. On a same-LAN device, open ${origin}/base.apk and install the base APK.`);
console.log("2. Open Vibe Tavern and use Check for launcher update.");
console.log("3. Confirm download, grant install permission when requested, then confirm Android's installer.");
console.log("If the device cannot connect, allow this port through Windows Firewall for private networks.");
