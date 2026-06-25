/**
 * Diagnostic: intercept the RAW HTTP response that the AI SDK receives from NanoGPT for Magnum,
 * to see why generateText throws "Invalid JSON response" while raw curl succeeds. We swap in a
 * custom fetch that logs the exact status, headers, and body the SDK's parser chokes on.
 *
 * Hypothesis to confirm/refute: NanoGPT returns a non-standard field (e.g. reasoning_content,
 * a second "choices" entry, or an SSE stream masquerading as JSON) for Magnum specifically, and
 * the AI SDK's OpenAI-compatible parser rejects it.
 */
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const db = new Database("../../data/vibe-tavern.db", { readonly: true });
const row = db
  .query("SELECT api_key FROM provider_profiles WHERE endpoint LIKE '%nano-gpt%' LIMIT 1")
  .get() as { api_key: string };
const KEY = row.api_key;

const estTok = (s: string): number => Math.ceil(s.length / 4);
const TARGET = 13000;
const trace = JSON.parse(
  readFileSync("c:/Users/user/Downloads/prompt-payload-trace_b955dc655ba9_0009.json", "utf8"),
) as { messages: any[] };
const msgs = trace.messages;
const isLayer = (m: any) => m.messageId === undefined;
const convo = msgs.filter((m) => !isLayer(m));
let remaining = Math.max(0, TARGET - estTok(msgs.filter(isLayer).map((m) => m.content).join("\n")));
const kept: typeof convo = [];
for (let i = convo.length - 1; i >= 0; i--) {
  const t = estTok(convo[i].content);
  if (t > remaining) break;
  kept.unshift(convo[i]);
  remaining -= t;
}
while (kept.length > 0 && kept[0].role !== "user") kept.shift();
const ids = new Set(kept.map((m) => m.messageId));
const ctx = msgs.filter((m) => isLayer(m) || ids.has(m.messageId!));

// Custom fetch that captures the raw response body before the SDK parses it.
const loggingFetch: typeof fetch = async (input, init) => {
  console.log("=== SDK request ===");
  const body = init?.body as string;
  if (body) {
    try {
      const j = JSON.parse(body);
      console.log("  model:", j.model);
      console.log("  stream:", j.stream);
      console.log("  messages:", j.messages?.length);
      console.log("  extra keys:", Object.keys(j).filter((k) => !["model", "messages", "stream"].includes(k)));
    } catch {
      console.log("  body (not JSON, first 200):", String(body).slice(0, 200));
    }
  }

  const res = await fetch(input, init);
  console.log("\n=== RAW response ===");
  console.log("  status:", res.status, res.statusText);
  console.log("  content-type:", res.headers.get("content-type"));
  // Clone so the SDK still gets a body to read.
  const clone = res.clone();
  const rawText = await clone.text();
  console.log("  body length:", rawText.length);
  // Peek at the top-level JSON shape to spot non-standard fields.
  try {
    const j = JSON.parse(rawText);
    console.log("  top-level keys:", Object.keys(j));
    if (j.choices?.[0]) {
      console.log("  choice[0] keys:", Object.keys(j.choices[0]));
      console.log("  message keys:", Object.keys(j.choices[0].message ?? {}));
      console.log("  finish_reason:", j.choices[0].finish_reason);
    }
    if (j.usage) console.log("  usage keys:", Object.keys(j.usage));
    // Flag any field the OpenAI SDK doesn't expect.
    const stdKeys = new Set(["id", "object", "created", "model", "choices", "usage", "system_fingerprint"]);
    const extra = Object.keys(j).filter((k) => !stdKeys.has(k));
    if (extra.length) console.log("  ⚠ NON-STANDARD top-level fields:", extra);
  } catch {
    console.log("  body is NOT valid JSON. First 500 chars:");
    console.log("  ", rawText.slice(0, 500));
  }
  return res;
};

const nanogpt = createOpenAICompatible({
  name: "nanogpt",
  apiKey: KEY,
  baseURL: "https://nano-gpt.com/api/v1",
  fetch: loggingFetch,
});

console.log("Calling Magnum via AI SDK with intercepted fetch...\n");
try {
  const res = await generateText({
    model: nanogpt("anthracite-org/magnum-v4-72b"),
    messages: ctx,
    maxOutputTokens: 800,
    allowSystemInMessages: true,
  });
  console.log("\n=== SDK result ===");
  console.log("  finishReason:", res.finishReason);
  console.log("  usage:", JSON.stringify(res.usage));
  console.log("  text length:", res.text.length);
} catch (e) {
  console.log("\n=== SDK threw ===");
  console.log("  error:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.cause) console.log("  cause:", e.cause);
}
