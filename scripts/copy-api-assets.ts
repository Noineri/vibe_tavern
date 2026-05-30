import { cp, copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const API_ASSETS = join(ROOT, "services", "api", "assets");
const API_OUT = join(ROOT, "out", "services", "api");
const DB_MIGRATIONS = join(ROOT, "packages", "db", "drizzle");

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

const promptSource = join(API_ASSETS, "script-ai-prompt.md");
const tokenizerSource = join(API_ASSETS, "tokenizers");

if (!(await exists(promptSource))) {
  throw new Error(`Script AI prompt source not found: ${promptSource}`);
}
if (!(await exists(tokenizerSource))) {
  throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
}
if (!(await exists(DB_MIGRATIONS))) {
  throw new Error(`DB migrations source not found: ${DB_MIGRATIONS}`);
}

await mkdir(API_OUT, { recursive: true });
await copyFile(promptSource, join(API_OUT, "script-ai-prompt.md"));
await cp(tokenizerSource, join(API_OUT, "tokenizers"), { recursive: true });
await cp(DB_MIGRATIONS, join(API_OUT, "drizzle"), { recursive: true });

console.log("[copy-api-assets] copied runtime assets to out/services/api");
