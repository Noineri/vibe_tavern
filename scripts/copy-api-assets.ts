import { cp, copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const API_ASSETS = join(ROOT, "services", "api", "assets");
const API_OUT = join(ROOT, "out", "services", "api");
const DB_MIGRATIONS = join(ROOT, "packages", "db", "drizzle");

// NOTE: must use `stat`, not `Bun.file(path).exists()`. Bun.file is a *file*
// abstraction — .exists() returns false for directories (the paths checked here
// — tokenizerSource, DB_MIGRATIONS — are directories). The earlier "migrate stat
// checks to Bun.file" refactor regressed this and broke dev:api startup.
// Bun's own docs route directory ops (mkdir/readdir/existence) to node:fs.
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

const tokenizerSource = join(API_ASSETS, "tokenizers");

const promptFiles = (await readdir(API_ASSETS)).filter((f) => f.endsWith(".md"));
if (promptFiles.length === 0) {
  throw new Error(`No .md prompt files found in ${API_ASSETS}`);
}
if (!(await exists(tokenizerSource))) {
  throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
}
if (!(await exists(DB_MIGRATIONS))) {
  throw new Error(`DB migrations source not found: ${DB_MIGRATIONS}`);
}

await mkdir(API_OUT, { recursive: true });
for (const file of promptFiles) {
  await copyFile(join(API_ASSETS, file), join(API_OUT, file));
}
await cp(tokenizerSource, join(API_OUT, "tokenizers"), { recursive: true });
await cp(DB_MIGRATIONS, join(API_OUT, "drizzle"), { recursive: true });

console.log("[copy-api-assets] copied runtime assets to out/services/api");
console.log(`  Prompts: ${promptFiles.join(", ")}`);
