/**
 * Direct nanogpt test — bypasses the entire platform.
 * Reads credentials from the same SQLite DB used by the app.
 * Usage: node scripts/test-nanogpt-direct.mjs
 */

import { DatabaseSync } from "node:sqlite";
import * as https from "node:https";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dirname, "..", "data", "app.sqlite");

function getActiveProfile() {
  const db = new DatabaseSync(DB_PATH);
  const row = db.prepare(`
    SELECT id, name, endpoint, api_key, default_model
    FROM provider_profiles
    WHERE is_active = 1
    LIMIT 1
  `).get();
  db.close();
  if (!row) throw new Error("No active provider profile found.");
  return row;
}

function httpRequest(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const startMs = Date.now();

    const req = transport.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: {
          ...headers,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        console.log(`\n=== RESPONSE HEADERS (${Date.now() - startMs}ms) ===`);
        console.log(`  Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`  HTTP Version: ${res.httpVersion}`);
        for (const [k, v] of Object.entries(res.headers)) {
          console.log(`  ${k}: ${v}`);
        }

        const chunks = [];
        let totalBytes = 0;
        let chunkCount = 0;

        res.on("data", (chunk) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
          chunkCount++;
          console.log(`  [chunk ${chunkCount}] +${chunk.length} bytes (total: ${totalBytes})`);
        });

        res.on("end", () => {
          const elapsed = Date.now() - startMs;
          const raw = Buffer.concat(chunks).toString("utf-8");
          console.log(`\n=== RESPONSE BODY (${elapsed}ms) ===`);
          console.log(`  Total bytes: ${raw.length}`);
          console.log(`  Total chunks: ${chunkCount}`);

          // Try to parse JSON
          try {
            const parsed = JSON.parse(raw);
            console.log(`\n  JSON parse: OK`);
            const content = parsed?.choices?.[0]?.message?.content;
            if (content) {
              console.log(`  Content length: ${content.length}`);
              console.log(`  Content preview: ${content.slice(0, 300)}`);
            } else {
              console.log(`  No content in choices[0].message`);
              console.log(`  Full response keys: ${Object.keys(parsed).join(", ")}`);
              console.log(`  Raw (first 500 chars): ${raw.slice(0, 500)}`);
            }
          } catch (e) {
            console.log(`\n  JSON parse: FAILED — ${e.message}`);
            const posMatch = /position\s+(\d+)/i.exec(e.message);
            const pos = posMatch ? Number(posMatch[1]) : null;
            if (pos != null) {
              console.log(`\n  --- Context around error position ${pos} ---`);
              const before = raw.slice(Math.max(0, pos - 100), pos);
              const after = raw.slice(pos, pos + 100);
              console.log(`  BEFORE: ${JSON.stringify(before)}`);
              console.log(`  AT/AFTER: ${JSON.stringify(after)}`);

              // Show byte-by-byte around error
              console.log(`\n  --- Hex dump around position ${pos} ---`);
              const dumpStart = Math.max(0, pos - 20);
              const dumpEnd = Math.min(raw.length, pos + 20);
              for (let i = dumpStart; i < dumpEnd; i++) {
                const ch = raw.charCodeAt(i);
                const marker = i === pos ? " <<< ERROR" : "";
                if (ch < 32 || ch > 126) {
                  console.log(`  [${i}] 0x${ch.toString(16).padStart(2, "0")} (${ch})${marker}`);
                } else {
                  console.log(`  [${i}] 0x${ch.toString(16).padStart(2, "0")} '${raw[i]}'${marker}`);
                }
              }
            }

            // Show last 200 chars of raw response
            console.log(`\n  --- Last 200 chars of body ---`);
            console.log(JSON.stringify(raw.slice(-200)));

            // Check if body seems truncated
            const lastBracket = raw.lastIndexOf("}");
            const lastBracket2 = raw.lastIndexOf("]");
            console.log(`\n  Body ends with: ${JSON.stringify(raw.slice(-10))}`);
            console.log(`  Last } at: ${lastBracket}, last ] at: ${lastBracket2}, body length: ${raw.length}`);
          }

          resolve(raw);
        });

        res.on("error", (err) => {
          console.log(`\n  RESPONSE STREAM ERROR: ${err.message}`);
          reject(err);
        });
      },
    );

    req.on("error", (err) => {
      console.log(`\n  REQUEST ERROR (${Date.now() - startMs}ms): ${err.message}`);
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Socket timeout after ${Math.floor(timeoutMs / 1000)}s`));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Main ──
const profile = getActiveProfile();
console.log(`Profile: ${profile.name} (${profile.id})`);
console.log(`Endpoint: ${profile.endpoint}`);
console.log(`Model: ${profile.default_model}`);
console.log(`API key: ${profile.api_key.slice(0, 6)}...${profile.api_key.slice(-4)}`);

const url = `${profile.endpoint.replace(/\/+$/, "")}/chat/completions`;

// Load real chat messages from the exported file
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const scriptDir = dirname(fileURLToPath(import.meta.url));

const chatData = JSON.parse(
  readFileSync(resolve(scriptDir, "test-chat-messages.json"), "utf-8"),
);
const realMessages = chatData.messages;

console.log(`\n  Using ${realMessages.length} real chat messages:`);
let totalContent = 0;
for (const m of realMessages) {
  console.log(`    ${m.role}: ${m.content.length} chars`);
  totalContent += m.content.length;
}
console.log(`  Total content: ${totalContent} chars`);

// Build request — use stream:true (like SillyTavern does)
const body = JSON.stringify({
  model: "zai-org/glm-5.1",
  messages: realMessages,
  temperature: 0.9,
  stream: false,
});

console.log(`\n=== REQUEST ===`);
console.log(`  URL: ${url}`);
console.log(`  Body length: ${body.length} bytes`);

await httpRequest(url, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${profile.api_key}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  body,
  timeoutMs: 120_000,
});

console.log(`\n=== DONE ===`);
