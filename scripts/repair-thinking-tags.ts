/**
 * One-time repair script: extracts <thinking>/<think...> tags from message_variants.content
 * into the reasoning column for variants that were imported before the extraction logic was added.
 *
 * Usage: bun run scripts/repair-thinking-tags.ts [path-to-db]
 */
const { Database } = require("bun:sqlite");

const DB_PATH = process.argv[2] || "data/rp-platform.db";

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");

const rows = db
  .query("SELECT id, content FROM message_variants WHERE content LIKE '%<think%' AND (reasoning IS NULL OR reasoning = '')")
  .all();

console.log(`Found ${rows.length} variants to repair.`);

const THINKING_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

let updated = 0;
const updateStmt = db.prepare("UPDATE message_variants SET content = ?, reasoning = ? WHERE id = ?");

const transaction = db.transaction(() => {
  for (const row of rows) {
    let reasoning = "";
    THINKING_RE.lastIndex = 0;
    const matches = row.content.matchAll(THINKING_RE);
    for (const match of matches) {
      reasoning += (reasoning ? "\n" : "") + match[1].trim();
    }

    THINKING_RE.lastIndex = 0;
    const mainContent = row.content.replace(THINKING_RE, "").trim();

    if (reasoning) {
      updateStmt.run(mainContent, reasoning, row.id);
      updated++;
    }
  }
});

transaction();
db.close();

console.log(`Repaired ${updated}/${rows.length} variants.`);
