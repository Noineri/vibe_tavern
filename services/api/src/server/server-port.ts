/**
 * Port-availability pre-check for the bind-first server bootstrap
 * (server-runtime.ts). Extracted from server-runtime when TC-6's backfill
 * wiring pushed that file over the 800-line arch-gate cap — the gate's own
 * remedy is extraction, never compression. Behavior is byte-identical to
 * the inline code this replaced.
 *
 * Checks whether the configured port is already bound; when it is (and the
 * caller asked for the pre-check), offers to kill the occupying PID — by
 * VERIFIED PID only, never by image name (owner ruling; the vt-guard
 * enforces the same rule on shell commands). Best-effort detection: a port
 * we cannot attribute to a PID is left to the caller to resolve manually.
 */

/** Options shared by the pre-check and the kill-and-wait loop. */
export interface PortCheckOptions {
	readonly host: string;
	readonly port: number;
	readonly tag: string;
}

export async function ensurePortAvailable(options: PortCheckOptions): Promise<void> {
	try {
		const testServer = Bun.serve({
			fetch: () => new Response(),
			port: options.port,
			hostname: options.host,
		});
		testServer.stop(true);
	} catch (err) {
		const code = typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : undefined;
		if (code !== "EADDRINUSE") throw err;

		console.error(`\n${options.tag} Port ${options.port} is already in use.`);
		const oldPid = findProcessOnPort(options.port);

		if (!oldPid) {
			console.error(`${options.tag} Could not find the process. Please kill it manually and try again.`);
			process.exit(1);
		}

		console.error(`${options.tag} Occupied by PID ${oldPid}.`);

		if (!process.stdin?.isTTY) {
			console.log(`${options.tag} Non-interactive mode — killing PID ${oldPid}...`);
			await killProcessAndWaitForPort(oldPid, options);
			return;
		}

		console.log(`${options.tag} Kill PID ${oldPid}? [Y/n]`);
		const input = await new Promise<string>((resolveInput) => {
			process.stdin.resume();
			process.stdin.once("data", (data: Buffer) => {
				process.stdin.pause();
				resolveInput(data.toString().trim());
			});
		});
		if (input === "" || input.toLowerCase() === "y") {
			await killProcessAndWaitForPort(oldPid, options);
		} else {
			console.error(`${options.tag} Cancelled. Exiting.`);
			process.exit(1);
		}
	}
}

function findProcessOnPort(port: number): string | null {
	try {
		if (process.platform === "win32") {
			const result = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe" });
			const lines = new TextDecoder().decode(result.stdout).split("\n");
			for (const line of lines) {
				if (line.includes(`:${port}`) && line.includes("LISTENING")) {
					return line.trim().split(/\s+/).pop() ?? null;
				}
			}
		} else {
			const result = Bun.spawnSync(["ss", "-tlnp"], { stdout: "pipe" });
			const lines = new TextDecoder().decode(result.stdout).split("\n");
			for (const line of lines) {
				if (line.includes(`:${port}`)) {
					const match = line.match(/pid=(\d+)/);
					return match?.[1] ?? null;
				}
			}
		}
	} catch { /* port detection is best-effort; returning null just means "do not pre-kill" */ }
	return null;
}

async function killProcessAndWaitForPort(pid: string, options: PortCheckOptions): Promise<void> {
	try {
		process.kill(Number(pid), "SIGTERM");
		for (let i = 0; i < 20; i++) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			try {
				const testServer = Bun.serve({ fetch: () => new Response(), port: options.port, hostname: options.host });
				testServer.stop(true);
				console.log(`${options.tag} Port ${options.port} freed.`);
				return;
			} catch { /* port still bound — keep polling until it frees or we time out */ }
		}
	} catch {
		console.error(`${options.tag} Failed to kill PID ${pid}. Exiting.`);
		process.exit(1);
	}
}
