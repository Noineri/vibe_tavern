const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { request } = require("node:http");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { URL } = require("node:url");

const workspaceDir = process.cwd();
const webWorkspaceDir = path.join(workspaceDir, "apps", "web");
const nodeExecutable = process.execPath;
const apiHost = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const webUrl = process.env.RP_PLATFORM_WEB_URL ?? "http://localhost:4173";
const apiUrl = process.env.RP_PLATFORM_API_URL ?? `http://${apiHost}:${apiPort}`;
const readyTimeoutMs = Number(process.env.RP_PLATFORM_LAUNCH_TIMEOUT_MS ?? "90000");
const openBrowserAutomatically = process.env.RP_PLATFORM_OPEN_BROWSER !== "0";
const logsDir = path.resolve(process.env.RP_PLATFORM_LOG_DIR || path.join(workspaceDir, "logs"));
const logFilePath = path.resolve(
  process.env.RP_PLATFORM_LOG_FILE || path.join(logsDir, "dev-launcher.log"),
);
const processLogPaths = {
  api: path.join(logsDir, "dev-api.log"),
  web: path.join(logsDir, "dev-web.log"),
};
const npmCliPath = resolveNpmCliPath();
const viteCliPath = path.join(workspaceDir, "node_modules", "vite", "bin", "vite.js");
const apiServerEntryPath = path.join(workspaceDir, "services", "api", "dist", "services", "api", "src", "dev-server.js");

fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(
  logFilePath,
  `=== RP Platform launcher started at ${new Date().toISOString()} ===\n`,
);
for (const childLogPath of Object.values(processLogPaths)) {
  fs.writeFileSync(
    childLogPath,
    `=== RP Platform process log started at ${new Date().toISOString()} ===\n`,
  );
}

const managedChildren = [];
let shuttingDown = false;
let browserOpened = false;

main().catch(async (error) => {
  logError(`[launcher] ${formatError(error)}`);
  await shutdown("launcher bootstrap failure", 1);
});

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
    command: nodeExecutable,
    args: [viteCliPath],
    cwd: webWorkspaceDir,
  });
  managedChildren.push(webProcess);

  await runFiniteProcess({
    label: "api-build",
    command: nodeExecutable,
    args: [npmCliPath, "run", "build:api-stack"],
    cwd: workspaceDir,
  });

  const apiProcess = spawnManagedProcess({
    label: "api",
    command: nodeExecutable,
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

function spawnManagedProcess({ label, command, args, cwd }) {
  return spawnManagedProcessInternal({
    label,
    command,
    args,
    cwd,
    shutdownOnExit: true,
  });
}

function spawnManagedProcessInternal({ label, command, args, cwd, shutdownOnExit }) {
  logInfo(`[launcher] Spawning ${label}: ${renderSpawnCommand(command, args, cwd)}`);

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  pipeStream(label, child.stdout);
  pipeStream(label, child.stderr);

  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    logError(`[launcher] Failed to start ${label}: ${formatError(error)}`);
    void shutdown(`${label} spawn error`, 1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (!shutdownOnExit) {
      return;
    }

    const detail = signal
      ? `signal ${signal}`
      : `exit code ${typeof code === "number" ? code : "unknown"}`;

    logError(`[launcher] ${label} stopped unexpectedly with ${detail}.`);
    void shutdown(`${label} exited`, typeof code === "number" ? code : 1);
  });

  return {
    label,
    child,
  };
}

async function runFiniteProcess({ label, command, args, cwd }) {
  const processRef = spawnManagedProcessInternal({
    label,
    command,
    args,
    cwd,
    shutdownOnExit: false,
  });
  managedChildren.push(processRef);

  const exit = await new Promise((resolve) => {
    processRef.child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (shuttingDown) {
    throw new Error(`${label} was interrupted during shutdown.`);
  }

  if (exit.signal || exit.code !== 0) {
    const detail = exit.signal
      ? `signal ${exit.signal}`
      : `exit code ${typeof exit.code === "number" ? exit.code : "unknown"}`;
    throw new Error(`${label} failed with ${detail}.`);
  }

  logInfo(`[launcher] ${label} completed successfully.`);
  removeManagedChild(processRef.child.pid);
}

function pipeStream(label, stream) {
  if (!stream) {
    return;
  }

  const processLogPath = getProcessLogPath(label);

  const reader = readline.createInterface({
    input: stream,
  });

  reader.on("line", (line) => {
    logInfo(`[${label}] ${line}`);
    if (processLogPath) {
      fs.appendFileSync(processLogPath, `${line}\n`);
    }
  });
}

async function waitForHttpOk(targetUrl, label) {
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

  throw new Error(`Timed out after ${readyTimeoutMs}ms while waiting for ${label} at ${targetUrl}.`);
}

async function assertLaunchPortsAreFree(targets) {
  for (const target of targets) {
    const occupancy = await checkPortOccupancy(target.targetUrl);
    if (occupancy.inUse) {
      throw new Error(
        `${target.label} launch aborted: ${occupancy.host}:${occupancy.port} is already in use. Stop the existing process on that port and run the launcher again.`,
      );
    }
  }
}

function checkPortOccupancy(targetUrl) {
  const parsed = new URL(targetUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    const finish = (inUse) => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve({ inUse, host, port });
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (error) => {
      if (error && (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH")) {
        finish(false);
        return;
      }

      finish(false);
    });

    socket.setTimeout(1000);
  });
}

function probeHttp(targetUrl) {
  return new Promise((resolve) => {
    const req = request(targetUrl, { method: "GET" }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 500));
    });

    req.on("error", () => {
      resolve(false);
    });

    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

function openBrowserOnce(targetUrl) {
  if (browserOpened) {
    return;
  }

  browserOpened = true;
  logInfo(`[launcher] Opening browser at ${targetUrl}`);

  if (process.platform === "win32") {
    const opener = spawn("cmd", ["/c", "start", "", targetUrl], {
      cwd: workspaceDir,
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [targetUrl], {
    cwd: workspaceDir,
    detached: true,
    stdio: "ignore",
  });
  opener.unref();
}

function attachSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      void shutdown(`received ${signal}`, 0);
    });
  }

  process.on("uncaughtException", (error) => {
    logError(`[launcher] Uncaught exception: ${formatError(error)}`);
    void shutdown("uncaught exception", 1);
  });

  process.on("unhandledRejection", (reason) => {
    logError(`[launcher] Unhandled rejection: ${formatError(reason)}`);
    void shutdown("unhandled rejection", 1);
  });
}

async function shutdown(reason, exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logInfo(`[launcher] Shutting down: ${reason}`);

  await Promise.allSettled(managedChildren.map(({ label, child }) => stopChild(label, child)));
  process.exit(exitCode);
}

function stopChild(label, child) {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) {
      resolve();
      return;
    }

    const finish = () => {
      child.removeListener("exit", finish);
      resolve();
    };

    child.once("exit", finish);

    const timeout = setTimeout(() => {
      child.removeListener("exit", finish);
      logWarn(`[launcher] Timed out while stopping ${label}.`);
      resolve();
    }, 5000);
    timeout.unref();

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", () => {
        clearTimeout(timeout);
      });
      return;
    }

    child.kill("SIGTERM");
  });
}

function removeManagedChild(pid) {
  const index = managedChildren.findIndex((entry) => entry.child.pid === pid);
  if (index !== -1) {
    managedChildren.splice(index, 1);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function renderSpawnCommand(command, args, cwd) {
  const serializedArgs = args.map(quoteArg).join(" ");
  return `${command} ${serializedArgs} (cwd: ${cwd})`;
}

function quoteArg(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function getProcessLogPath(label) {
  if (label.startsWith("api")) {
    return processLogPaths.api;
  }

  if (label.startsWith("web")) {
    return processLogPaths.web;
  }

  return null;
}

function resolveNpmCliPath() {
  // Candidate 1: Windows / nvm-style — npm lives next to node.exe
  // (e.g. C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js)
  const nodeDir = path.dirname(nodeExecutable);
  const candidateNextToNode = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(candidateNextToNode)) {
    return candidateNextToNode;
  }

  // Candidate 2: Linux system packages (Debian/Ubuntu/Fedora) — npm is under
  // /usr/lib/node_modules even though node lives in /usr/bin.
  const parentDir = path.dirname(nodeDir);
  const candidateLibNodeModules = path.join(parentDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(candidateLibNodeModules)) {
    return candidateLibNodeModules;
  }

  // Candidate 3: macOS Homebrew — node at /opt/homebrew/bin/node or
  // /usr/local/bin/node, npm modules in ../lib/node_modules.
  // (Already covered by candidate 2 on most setups, but be explicit.)
  const homebrewLibCandidates = ["/opt/homebrew", "/usr/local"].map((prefix) =>
    path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  for (const candidate of homebrewLibCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Candidate 4: Fallback — resolve dynamically via "npm root -g".
  try {
    const npmRoot = require("node:child_process")
      .execSync("npm root -g", { encoding: "utf-8" })
      .trim();
    const candidateFromNpmRoot = path.join(npmRoot, "npm", "bin", "npm-cli.js");
    if (fs.existsSync(candidateFromNpmRoot)) {
      return candidateFromNpmRoot;
    }
  } catch {
    // npm root -g failed, fall through to the error below.
  }

  throw new Error(
    `npm CLI was not found.\n` +
      `  Tried:\n` +
      `    - ${candidateNextToNode}\n` +
      `    - ${candidateLibNodeModules}\n` +
      `    - ${homebrewLibCandidates.join("\n    - ")}\n` +
      `  Please ensure npm is installed and accessible.`,
  );
}

function logInfo(message) {
  logLine("INFO", message, process.stdout);
}

function logWarn(message) {
  logLine("WARN", message, process.stderr);
}

function logError(message) {
  logLine("ERROR", message, process.stderr);
}

function logLine(level, message, stream) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  fs.appendFileSync(logFilePath, `${line}\n`);
  stream.write(`${line}\n`);
}
