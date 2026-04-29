import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import * as fs from "node:fs";

const DB_PATH = resolve(import.meta.dirname, "..", "data", "app.sqlite");
const chatId = "chat_moiz5fgl74flhg_0001";

const db = new DatabaseSync(DB_PATH);

// Get active branch for this chat
const chat = db.prepare("SELECT active_branch_id FROM chats WHERE id = ?").get(chatId);
console.log("Active branch:", chat?.active_branch_id);

// Get all messages for this chat
const msgs = db.prepare(`
  SELECT m.id, m.role, m.content, m.position
  FROM messages m
  WHERE m.branch_id = ?
  ORDER BY m.position ASC
`).all(chat?.active_branch_id);

console.log(`Messages: ${msgs.length}`);
for (const m of msgs) {
  console.log(`  [${m.position}] ${m.role}: ${m.content.length} chars — ${m.content.slice(0, 80)}...`);
}

// Write the full messages to a file so we can use them in the test
const output = {
  messages: msgs.map(m => ({ role: m.role, content: m.content })),
};

fs.writeFileSync(
  resolve(import.meta.dirname, "test-chat-messages.json"),
  JSON.stringify(output, null, 2),
);

console.log("\nWritten to scripts/test-chat-messages.json");

db.close();
