/*
 * Entry point for the npm distribution (`bun install -g vibe-tavern`).
 *
 * Unlike every other channel, this one is NOT a compiled binary — it is a JS
 * bundle executed by the user's own bun. Two consequences drive this file:
 *
 *   1. process.execPath points at the user's bun (~/.bun/bin/bun), not at
 *      anything belonging to Vibe Tavern. Every "next to the program" lookup
 *      must be anchored on import.meta.dir instead, which build-npm-dist.ts
 *      guarantees is the package root (web/, tokenizers/, drizzle/ and the
 *      prompt .md files are all siblings of the bundle).
 *
 *   2. There is nothing to swap. Updating is `bun add -g vibe-tavern@X.Y.Z`,
 *      which the package manager does far better than a hand-rolled installer,
 *      so the download/verify/extract/swap pipeline and its rollback machinery
 *      are deliberately absent here.
 *
 * Usage:
 *   vibe-tavern
 *   vibe-tavern --version
 */

import { parseArgs } from "node:util";
import { resolveStandalonePaths } from "./standalone-paths.js";
import { startServerRuntime } from "./server-runtime.js";
import { getCurrentVersion, printVersion } from "./updater.js";
import { runNpmCheckUpdate, runNpmUpdate } from "../domain/update/npm-update.js";

const PACKAGE_ROOT = import.meta.dir;

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		version: { type: "boolean", short: "v" },
		yes: { type: "boolean", short: "y" },
	},
	strict: false,
	allowPositionals: true,
});

if (values.version === true) {
	printVersion();
	process.exit(0);
}

const subcommand = positionals[0];
if (subcommand === "check-update") {
	void runNpmCheckUpdate();
} else if (subcommand === "update") {
	void runNpmUpdate({ yes: values.yes === true });
} else if (subcommand === "rollback") {
	// The binary channel rolls back by restoring the tree its last swap
	// replaced. Nothing here keeps a copy of the previous version — but the
	// package manager can fetch any published one, which is strictly better
	// than a single-step undo.
	console.log(`Vibe Tavern v${getCurrentVersion()} was installed with bun.`);
	console.log("");
	console.log("  Roll back to a specific version: bun add -g vibe-tavern@<version>");
	console.log("  Published versions:              bun pm view vibe-tavern versions");
	console.log("");
	console.log("Releases: https://github.com/Noineri/vibe_tavern/releases");
	process.exit(1);
} else {
	void main();
}

async function main() {
	const paths = await resolveStandalonePaths({ baseDir: PACKAGE_ROOT });
	// Same default as the standalone build: mobile access is a shipped feature
	// and it needs a non-loopback bind. Deviating here would make "mobile access
	// doesn't work" depend on which channel the user installed from.
	const host = process.env.VIBE_TAVERN_HOST ?? "0.0.0.0";

	console.log(`[npm] Vibe Tavern v${getCurrentVersion()}`);

	await startServerRuntime({
		mode: "standalone",
		dataDir: paths.dataDir,
		assetsDir: paths.assetsDir,
		staticDir: paths.webDir,
		staticEnabled: paths.webEnabled,
		host,
		port: paths.port,
		logsDir: paths.logsDir,
		extraDataDirs: [paths.traceDir],
		shutdownSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
		missingFrontendMessage:
			"Frontend not found in the installed package. Reinstall with: bun add -g vibe-tavern@latest",
	}).catch((err) => {
		console.error("[npm] Fatal error:", err);
		process.exit(1);
	});
}
