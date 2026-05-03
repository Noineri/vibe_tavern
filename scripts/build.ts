/**
 * Production build script using Bun.build()
 *
 * Usage: bun scripts/build.ts [package]
 *   package: "api-stack" (default) | "domain" | "db" | "prompt-pipeline" | "import-export" | "api" | "web"
 *
 * For dev, packages run .ts directly — no build needed.
 * This script is for production Docker / deployment.
 */

import { join, resolve } from "path";
import { readdir } from "fs/promises";

const ROOT = resolve(import.meta.dir, "..");

interface PackageConfig {
  name: string;
  dir: string;
  entrypoints: string[];
  outdir: string;
  external: string[];
}

const PACKAGES: Record<string, PackageConfig> = {
  domain: {
    name: "@rp-platform/domain",
    dir: "packages/domain",
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    external: [],
  },
  "prompt-pipeline": {
    name: "@rp-platform/prompt-pipeline",
    dir: "packages/prompt-pipeline",
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    external: ["@rp-platform/domain"],
  },
  db: {
    name: "@rp-platform/db",
    dir: "packages/db",
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    external: ["@rp-platform/domain"],
  },
  "import-export": {
    name: "@rp-platform/import-export",
    dir: "packages/import-export",
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    external: ["@rp-platform/domain"],
  },
  api: {
    name: "@rp-platform/api",
    dir: "services/api",
    entrypoints: ["src/index.ts", "src/dev-server.ts"],
    outdir: "dist",
    external: [
      "@rp-platform/db",
      "@rp-platform/domain",
      "@rp-platform/import-export",
      "@rp-platform/prompt-pipeline",
    ],
  },
};

const API_STACK_ORDER = [
  "domain",
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
        outdir: join(absDir, pkg.outdir),
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

  return results.every(Boolean);
}

async function main() {
  const target = process.argv[2] || "api-stack";
  let packages: PackageConfig[];

  if (target === "api-stack") {
    packages = API_STACK_ORDER.map((name) => PACKAGES[name]);
  } else if (PACKAGES[target]) {
    packages = [PACKAGES[target]];
  } else {
    console.error(`Unknown target: ${target}`);
    console.error(
      `Valid targets: api-stack, ${Object.keys(PACKAGES).join(", ")}`
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
