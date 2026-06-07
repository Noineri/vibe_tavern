/**
 * Production build script using Bun.build()
 *
 * Usage: bun scripts/build.ts [package]
 *   package: "api-stack" (default) | "domain" | "db" | "prompt-pipeline" | "import-export" | "api" | "web"
 *
 * For dev, packages run .ts directly — no build needed.
 * This script is for production Docker / deployment.
 */

import { join, relative, resolve } from "node:path";
import { copyFile, cp, mkdir, stat } from "node:fs/promises";

const ROOT = resolve(import.meta.dir, "..");

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function copyApiRuntimeAssets() {
  const apiOut = join(ROOT, "out", "services", "api");
  const promptDir = join(ROOT, "services", "api", "assets");
  const tokenizerSource = join(ROOT, "services", "api", "assets", "tokenizers");
  const tokenizerTargets = [join(apiOut, "tokenizers")];
  const migrationsSource = join(ROOT, "packages", "db", "drizzle");
  const migrationsTarget = join(apiOut, "drizzle");

  const { readdir } = await import("node:fs/promises");
  const promptFiles = (await readdir(promptDir)).filter((f) => f.endsWith(".md"));
  if (promptFiles.length === 0) {
    throw new Error(`No .md prompt files found in ${promptDir}`);
  }
  if (!(await exists(tokenizerSource))) {
    throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
  }
  if (!(await exists(migrationsSource))) {
    throw new Error(`DB migrations source not found: ${migrationsSource}`);
  }

  const promptTargets = [];
  for (const file of promptFiles) {
    const target = join(apiOut, file);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(promptDir, file), target);
    promptTargets.push(target);
  }
  for (const tokenizerTarget of tokenizerTargets) {
    await cp(tokenizerSource, tokenizerTarget, { recursive: true });
  }
  await cp(migrationsSource, migrationsTarget, { recursive: true });

  console.log("  ✅ Runtime assets copied:");
  for (const target of [...promptTargets, ...tokenizerTargets, migrationsTarget]) {
    console.log(`     ${relative(ROOT, target)}`);
  }
}

interface PackageConfig {
  name: string;
  dir: string;
  entrypoints: string[];
  outdir: string;
  external: string[];
}

const PACKAGES: Record<string, PackageConfig> = {
  domain: {
    name: "@vibe-tavern/domain",
    dir: "packages/domain",
    entrypoints: ["src/index.ts"],
    outdir: "out/packages/domain",
    external: [],
  },
  "api-contracts": {
    name: "@vibe-tavern/api-contracts",
    dir: "packages/api-contracts",
    entrypoints: ["src/index.ts"],
    outdir: "out/packages/api-contracts",
    external: [],
  },
  "prompt-pipeline": {
    name: "@vibe-tavern/prompt-pipeline",
    dir: "packages/prompt-pipeline",
    entrypoints: ["src/index.ts"],
    outdir: "out/packages/prompt-pipeline",
    external: ["@vibe-tavern/domain"],
  },
  db: {
    name: "@vibe-tavern/db",
    dir: "packages/db",
    entrypoints: ["src/index.ts"],
    outdir: "out/packages/db",
    external: ["@vibe-tavern/domain"],
  },
  "import-export": {
    name: "@vibe-tavern/import-export",
    dir: "packages/import-export",
    entrypoints: ["src/index.ts"],
    outdir: "out/packages/import-export",
    external: ["@vibe-tavern/domain"],
  },
  api: {
    name: "@vibe-tavern/api",
    dir: "services/api",
    entrypoints: ["src/index.ts", "src/server/prod-server.ts"],
    outdir: "out/services/api",
    external: [],
  },
};

const API_STACK_ORDER = [
  "domain",
  "api-contracts",
  "prompt-pipeline",
  "db",
  "import-export",
  "api",
];

async function buildPackage(pkg: PackageConfig) {
  const absDir = join(ROOT, pkg.dir);

  console.log(`📦 Building ${pkg.name}...`);

  const results = await Promise.all(
    pkg.entrypoints.map(async (entry) => {
      const entrypoint = join(absDir, entry);
      const result = await Bun.build({
        entrypoints: [entrypoint],
        outdir: join(ROOT, pkg.outdir),
        target: "bun",
        external: pkg.external,
        sourcemap: "external",
        minify: false,
        declaration: true,
      });

      if (!result.success) {
        console.error(`  ❌ Failed: ${entry}`);
        for (const log of result.logs) {
          console.error(`    ${log}`);
        }
        return false;
      }

      for (const output of result.outputs) {
        console.log(`  ✅ ${output.path.replace(ROOT + "/", "")}`);
      }
      return true;
    })
  );

  const ok = results.every(Boolean);
  if (ok && pkg.dir === "services/api") {
    await copyApiRuntimeAssets();
  }
  return ok;
}

async function main() {
  const target = process.argv[2] || "api-stack";
  let packages: PackageConfig[];

  if (target === "web") {
    // Build frontend via Vite
    console.log("📦 Building frontend (vite build)...\n");
    const proc = Bun.spawn(["bun", "run", "--filter", "@vibe-tavern/web", "build"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("❌ Frontend build failed");
      process.exit(1);
    }
    console.log("\n✅ Frontend built to out/apps/web/");
    return;
  }

  if (target === "prod") {
    // Build API stack + frontend in sequence
    console.log("🔨 Building full production bundle\n");

    // 1. API stack
    for (const name of API_STACK_ORDER) {
      const ok = await buildPackage(PACKAGES[name]);
      if (!ok) {
        console.error("❌ API build failed");
        process.exit(1);
      }
      console.log();
    }

    // 2. Frontend
    console.log("📦 Building frontend (vite build)...\n");
    const proc = Bun.spawn(["bun", "run", "--filter", "@vibe-tavern/web", "build"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("❌ Frontend build failed");
      process.exit(1);
    }

    console.log("\n✅ Production bundle ready.");
    console.log("   Run: bun out/services/api/prod-server.js");
    return;
  }

  if (target === "api-stack") {
    packages = API_STACK_ORDER.map((name) => PACKAGES[name]);
  } else if (PACKAGES[target]) {
    packages = [PACKAGES[target]];
  } else {
    console.error(`Unknown target: ${target}`);
    console.error(
      `Valid targets: prod, api-stack, web, ${Object.keys(PACKAGES).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`🔨 Bun.build — target: ${target}\n`);

  let failed = false;
  for (const pkg of packages) {
    const ok = await buildPackage(pkg);
    if (!ok) failed = true;
    console.log();
  }

  if (failed) {
    console.error("❌ Build failed");
    process.exit(1);
  }

  console.log("✅ All packages built successfully");
}

main();
