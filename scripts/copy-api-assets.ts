import { cp, copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const API_ASSETS = join(ROOT, "services", "api", "assets");
const API_OUT = join(ROOT, "out", "services", "api");
const DB_MIGRATIONS = join(ROOT, "packages", "db", "drizzle");

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
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
