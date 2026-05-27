/**
 * One-time repair script: extracts <thinking>/<think...> tags from
 * message_variants.content AND messages.content into the reasoning column.
 *
 * Phase 1: Fix variants (reasoning column + strip tags from variant content)
 * Phase 2: Sync messages.content with selected variant content
 *
 * Usage: bun run scripts/repair-thinking-tags.ts [path-to-db]
 */
import { Database } from "bun:sqlite";

const DB_PATH = process.argv[2] || "data/vibe-tavern.db";

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

const THINKING_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;

// ── Phase 1: Fix variants ──
const variantRows = db
  .query("SELECT id, content, reasoning FROM message_variants WHERE content LIKE '%<think%'")
  .all();

console.log(`Phase 1: Found ${variantRows.length} variants with <thinking> tags in content.`);

const updateVariant = db.prepare("UPDATE message_variants SET content = ?, reasoning = ? WHERE id = ?");
let variantsFixed = 0;

const tx1 = db.transaction(() => {
  for (const row of variantRows) {
    THINKING_RE.lastIndex = 0;
    const matches = [...row.content.matchAll(THINKING_RE)];

    let tagReasoning = matches
      .map((m: RegExpMatchArray) =>
        m[0]
          .replace(/^<think(?:ing)?>\s*/i, "")
          .replace(/\s*<\/think(?:ing)?>$/i, "")
          .trim(),
      )
      .filter(Boolean)
      .join("\n\n");

    THINKING_RE.lastIndex = 0;
    const mainContent = row.content.replace(THINKING_RE, "").trim();

    // Merge with existing reasoning
    const existingReasoning = row.reasoning?.trim() || "";
    const combinedReasoning = [existingReasoning, tagReasoning].filter(Boolean).join("\n\n");

    if (tagReasoning || existingReasoning !== combinedReasoning) {
      updateVariant.run(mainContent, combinedReasoning, row.id);
      variantsFixed++;
    }
  }
});
tx1();
console.log(`Phase 1: Fixed ${variantsFixed}/${variantRows.length} variants.`);

// ── Phase 2: Sync messages.content from selected variant ──
const messageRows = db
  .query(`
    SELECT m.id as msg_id, mv.content as variant_content
    FROM messages m
    JOIN message_variants mv ON mv.message_id = m.id AND mv.is_selected = 1
    WHERE m.content LIKE '%<think%'
  `)
  .all();

console.log(`\nPhase 2: Found ${messageRows.length} messages with stale content.`);

const updateMessage = db.prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?");
let messagesFixed = 0;

const tx2 = db.transaction(() => {
  const now = new Date().toISOString();
  for (const row of messageRows) {
    updateMessage.run(row.variant_content, now, row.msg_id);
    messagesFixed++;
  }
});
tx2();
console.log(`Phase 2: Fixed ${messagesFixed}/${messageRows.length} messages.`);

// ── Verify ──
const remainingVariants = db
  .query("SELECT COUNT(*) as cnt FROM message_variants WHERE content LIKE '%<think%'")
  .get() as { cnt: number };
const remainingMessages = db
  .query("SELECT COUNT(*) as cnt FROM messages WHERE content LIKE '%<think%'")
  .get() as { cnt: number };

console.log(`\nRemaining: ${remainingVariants.cnt} variants, ${remainingMessages.cnt} messages with <thinking> tags.`);
db.close();
