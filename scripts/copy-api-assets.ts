import { cp, copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "./_fs.js";
import { copyPromptAssets } from "./_prompt-assets.js";

const ROOT = resolve(import.meta.dir, "..");
const API_ASSETS = join(ROOT, "services", "api", "assets");
const API_OUT = join(ROOT, "out", "services", "api");
const DB_MIGRATIONS = join(ROOT, "packages", "db", "drizzle");

const tokenizerSource = join(API_ASSETS, "tokenizers");

if (!(await pathExists(tokenizerSource))) {
	throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
}
if (!(await pathExists(DB_MIGRATIONS))) {
	throw new Error(`DB migrations source not found: ${DB_MIGRATIONS}`);
}

await mkdir(API_OUT, { recursive: true });
// Flat *.md + every nested prompt tree (coauthor/, experience-copilot/) via
// the shared copier — see _prompt-assets.ts history.
const promptTargets = await copyPromptAssets(API_ASSETS, API_OUT);
await cp(tokenizerSource, join(API_OUT, "tokenizers"), { recursive: true });
await cp(DB_MIGRATIONS, join(API_OUT, "drizzle"), { recursive: true });

console.log("[copy-api-assets] copied runtime assets to out/services/api");
console.log(`  Prompts: ${promptTargets.map((p) => p.slice(API_OUT.length + 1)).join(", ")}`);
