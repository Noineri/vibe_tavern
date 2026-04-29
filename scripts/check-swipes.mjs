import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const db = new DatabaseSync(resolve(import.meta.dirname, "..", "data", "app.sqlite"));
const chatId = "chat_moiz5fgl74flhg_0001";
const msgId = "msg_moj0d11fu4dico_0002";

const variants = db.prepare(`
  SELECT mv.id, mv.content, mv.variant_index, mv.created_at
  FROM message_variants mv
  JOIN messages m ON m.id = mv.message_id
  JOIN chat_branches cb ON m.branch_id = cb.id
  WHERE cb.chat_id = ? AND m.id = ?
  ORDER BY mv.variant_index ASC
`).all(chatId, msgId);

console.log(`Variants for ${msgId}: ${variants.length}`);
for (const [i, v] of variants.entries()) {
  const ts = new Date(v.created_at).toISOString().slice(0, 19);
  console.log(`  [${i}] ${String(v.content).length} chars, at=${ts}`);
}

// Also check: does any content contain reasoning markers?
let reasoningCount = 0;
for (const v of variants) {
  const c = String(v.content);
  if (c.includes("<think") || c.includes("<reasoning") || c.includes("reasoning")) {
    reasoningCount++;
  }
}
console.log(`\nVariants with reasoning markers in content: ${reasoningCount}`);

// Check the timestamps of the variants
const timestamps = variants.map(v => new Date(v.created_at).toISOString().slice(0, 19));
console.log(`Timestamps: ${timestamps.join(", ")}`);

db.close();
