import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const workspaceDir = process.cwd();
const webWorkspaceDir = join(workspaceDir, "apps", "web");
const bunExecutable = process.env.BUN_EXE || process.env.BUN_EXECUTABLE || "bun";
const apiHost = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const webUrl = process.env.RP_PLATFORM_WEB_URL ?? "http://localhost:4173";
const apiUrl = process.env.RP_PLATFORM_API_URL ?? `http://${apiHost}:${apiPort}`;
const readyTimeoutMs = Number(process.env.RP_PLATFORM_LAUNCH_TIMEOUT_MS ?? "90000");
const openBrowserAutomatically = process.env.RP_PLATFORM_OPEN_BROWSER !== "0";
const logsDir = resolve(process.env.RP_PLATFORM_LOG_DIR || join(workspaceDir, "logs"));
const logFilePath = resolve(
  process.env.RP_PLATFORM_LOG_FILE || join(logsDir, "dev-launcher.log"),
);
const processLogPaths = {
  api: join(logsDir, "dev-api.log"),
  web: join(logsDir, "dev-web.log"),
};
const viteCliPath = join(workspaceDir, "node_modules", "vite", "bin", "vite.js");
const apiServerEntryPath = join(workspaceDir, "services", "api", "src", "dev-server.ts");

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

import { mkdir } from "node:fs/promises";
await mkdir(logsDir, { recursive: true });
await Bun.write(logFilePath, `=== RP Platform launcher started at ${new Date().toISOString()} ===\n`);
for (const childLogPath of Object.values(processLogPaths)) {
  await Bun.write(childLogPath, `=== RP Platform process log started at ${new Date().toISOString()} ===\n`);
}

const managedChildren: Array<{ label: string; child: Subprocess }> = [];
let shuttingDown = false;
let browserOpened = false;

main().catch(async (error) => {
  logError(`[launcher] ${formatError(error)}`);
  await shutdown("launcher bootstrap failure", 1);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logInfo(`[launcher] Workspace: ${workspaceDir}`);
  logInfo(`[launcher] Log file: ${logFilePath}`);
  logInfo(`[launcher] API process log: ${processLogPaths.api}`);
  logInfo(`[launcher] Web process log: ${processLogPaths.web}`);
  logInfo(`[launcher] API target: ${apiUrl}`);
  logInfo(`[launcher] Web target: ${webUrl}`);

  attachSignalHandlers();

  await assertLaunchPortsAreFree([
    { targetUrl: apiUrl, label: "API" },
    { targetUrl: webUrl, label: "web" },
  ]);

  const webProcess = spawnManagedProcess({
    label: "web",
    command: bunExecutable,
    args: [viteCliPath],
    cwd: webWorkspaceDir,
  });
  managedChildren.push(webProcess);

  await runFiniteProcess({
    label: "api-build",
    command: bunExecutable,
    args: ["run", "build:api-stack"],
    cwd: workspaceDir,
  });

  const apiProcess = spawnManagedProcess({
    label: "api",
    command: bunExecutable,
    args: [apiServerEntryPath],
    cwd: workspaceDir,
  });
  managedChildren.push(apiProcess);

  logInfo("[launcher] Waiting for API and web dev servers...");

  await Promise.all([
    waitForHttpOk(`${apiUrl}/health`, "API health endpoint"),
    waitForHttpOk(webUrl, "web dev server"),
  ]);

  logInfo("[launcher] API and web are ready.");

  if (openBrowserAutomatically) {
    openBrowserOnce(webUrl);
  } else {
    logInfo("[launcher] Browser auto-open disabled by RP_PLATFORM_OPEN_BROWSER=0.");
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

interface SpawnOpts {
  label: string;
  command: string;
  args: string[];
  cwd: string;
}

function spawnManagedProcess(opts: SpawnOpts) {
  return spawnManagedProcessInternal({ ...opts, shutdownOnExit: true });
}

function spawnManagedProcessInternal(
  opts: SpawnOpts & { shutdownOnExit: boolean },
) {
  const { label, command, args, cwd, shutdownOnExit } = opts;
  logInfo(`[launcher] Spawning ${label}: ${renderSpawnCommand(command, args, cwd)}`);

  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  pipeStream(label, child.stdout);
  pipeStream(label, child.stderr);

  // Watch for unexpected exit
  (async () => {
    const exitCode = await child.exited;
    if (shuttingDown) return;
    if (!shutdownOnExit) return;

    // Windows: exit code 58 = SIGTERM through taskkill, 1 = SIGINT through Ctrl+C.
    // Both are expected when the user closes the terminal or presses Ctrl+C.
    const isGracefulWindowsExit =
      process.platform === "win32" && (exitCode === 58 || exitCode === 1);

    if (isGracefulWindowsExit) {
      logInfo(`[launcher] ${label} exited with code ${exitCode} (graceful shutdown).`);
      void shutdown(`${label} exited`, 0);
      return;
    }

    logError(`[launcher] ${label} stopped unexpectedly with exit code ${exitCode}.`);
    void shutdown(`${label} exited`, exitCode);
  })();

  return { label, child };
}

async function runFiniteProcess(opts: SpawnOpts) {
  const processRef = spawnManagedProcessInternal({ ...opts, shutdownOnExit: false });
  managedChildren.push(processRef);

  const exitCode = await processRef.child.exited;

  if (shuttingDown) {
    throw new Error(`${opts.label} was interrupted during shutdown.`);
  }

  if (exitCode !== 0) {
    throw new Error(`${opts.label} failed with exit code ${exitCode}.`);
  }

  logInfo(`[launcher] ${opts.label} completed successfully.`);
  removeManagedChild(processRef.child.pid);
}

// ---------------------------------------------------------------------------
// Stream piping
// ---------------------------------------------------------------------------

function pipeStream(label: string, stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return;

  const processLogPath = getProcessLogPath(label);

  (async () => {
    const reader = (stream as ReadableStream<any>)
      .pipeThrough(new TextDecoderStream())
      .getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const line of value.split("\n")) {
          logInfo(`[${label}] ${line}`);
          if (processLogPath) {
            await Bun.write(processLogPath, `${line}\n`, { append: true });
          }
        }
      }
    } catch {
      // Stream closed during shutdown — ignore
    }
  })();
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

async function waitForHttpOk(targetUrl: string, label: string) {
  const deadline = Date.now() + readyTimeoutMs;

  while (Date.now() < deadline) {
    if (shuttingDown) {
      throw new Error(`Stopped while waiting for ${label}.`);
    }

    const isReady = await probeHttp(targetUrl);
    if (isReady) {
      logInfo(`[launcher] ${label} is ready at ${targetUrl}`);
      return;
    }

    await delay(500);
  }

  throw new Error(
    `Timed out after ${readyTimeoutMs}ms while waiting for ${label} at ${targetUrl}.`,
  );
}

async function assertLaunchPortsAreFree(
  targets: Array<{ targetUrl: string; label: string }>,
) {
  for (const target of targets) {
    const occupancy = await checkPortOccupancy(target.targetUrl);
    if (occupancy.inUse) {
      throw new Error(
        `${target.label} launch aborted: ${occupancy.host}:${occupancy.port} is already in use. Stop the existing process on that port and run the launcher again.`,
      );
    }
  }
}

async function checkPortOccupancy(
  targetUrl: string,
): Promise<{ inUse: boolean; host: string; port: number }> {
  const parsed = new URL(targetUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  // Use fetch probe — if anything responds, the port is occupied
  try {
    await fetch(`${parsed.protocol}//${host}:${port}`, {
      signal: AbortSignal.timeout(1000),
    });
    return { inUse: true, host, port };
  } catch {
    // Connection refused = port free
    return { inUse: false, host, port };
  }
}

async function probeHttp(targetUrl: string): Promise<boolean> {
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function openBrowserOnce(targetUrl: string) {
  if (browserOpened) return;

  browserOpened = true;
  logInfo(`[launcher] Opening browser at ${targetUrl}`);

  const args =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", targetUrl]
      : process.platform === "darwin"
        ? ["open", targetUrl]
        : ["xdg-open", targetUrl];

  const opener = Bun.spawn(args, {
    cwd: workspaceDir,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
  });
  (opener as any).unref();
}

// ---------------------------------------------------------------------------
// Signal handling & shutdown
// ---------------------------------------------------------------------------

function attachSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void shutdown(`received ${signal}`, 0);
    });
  }

  process.on("uncaughtException", (error: unknown) => {
    logError(`[launcher] Uncaught exception: ${formatError(error)}`);
    void shutdown("uncaught exception", 1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logError(`[launcher] Unhandled rejection: ${formatError(reason)}`);
    void shutdown("unhandled rejection", 1);
  });
}

async function shutdown(reason: string, exitCode: number) {
  if (shuttingDown) return;

  shuttingDown = true;
  logInfo(`[launcher] Shutting down: ${reason}`);

  await Promise.allSettled(
    managedChildren.map(({ label, child }) => stopChild(label, child)),
  );
  process.exit(exitCode);
}

function stopChild(
  label: string,
  child: Subprocess,
): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || !child.killed) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      logWarn(`[launcher] Timed out while stopping ${label}.`);
      resolve();
    }, 5000);
    (timeout as any).unref();

    child.exited.then(() => {
      clearTimeout(timeout);
      resolve();
    });

    if (process.platform === "win32") {
      const killer = Bun.spawn(
        ["taskkill", "/pid", String(child.pid), "/T", "/F"],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      );
      killer.exited.then(() => clearTimeout(timeout));
      return;
    }

    child.kill();
  });
}

function removeManagedChild(pid: number | undefined) {
  if (pid === undefined) return;
  const index = managedChildren.findIndex((entry) => entry.child.pid === pid);
  if (index !== -1) {
    managedChildren.splice(index, 1);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function renderSpawnCommand(command: string, args: string[], cwd: string) {
  const serializedArgs = args.map(quoteArg).join(" ");
  return `${command} ${serializedArgs} (cwd: ${cwd})`;
}

function quoteArg(value: string) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function getProcessLogPath(label: string): string | null {
  if (label.startsWith("api")) return processLogPaths.api;
  if (label.startsWith("web")) return processLogPaths.web;
  return null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logInfo(message: string) {
  logLine("INFO", message, process.stdout);
}

function logWarn(message: string) {
  logLine("WARN", message, process.stderr);
}

function logError(message: string) {
  logLine("ERROR", message, process.stderr);
}

function logLine(level: string, message: string, stream: typeof process.stdout) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  Bun.write(logFilePath, `${line}\n`, { append: true }); // fire-and-forget
  stream.write(`${line}\n`);
}
