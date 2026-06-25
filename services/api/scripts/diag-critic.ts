/**
 * Diagnostic: see what the critic model (Kimi-code) actually returns for the critic prompt,
 * to fix "No JSON object found". Likely causes: (a) maxOutputTokens cuts the JSON mid-stream,
 * (b) model wraps JSON in prose/markdown the extractor misses, (c) model emits <think> reasoning.
 * Logs finishReason, usage, full raw text + what extractJsonObject finds.
 */
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const db = new Database("../../data/vibe-tavern.db", { readonly: true });
const KEY = db.query("SELECT api_key FROM provider_profiles WHERE endpoint LIKE '%nano-gpt%' LIMIT 1").get().api_key;
const nanogpt = createOpenAICompatible({ name: "nanogpt", apiKey: KEY, baseURL: "https://nano-gpt.com/api/v1" });

const estTok = (s: string): number => Math.ceil(s.length / 4);
const trace = JSON.parse(readFileSync("c:/Users/user/Downloads/prompt-payload-trace_b955dc655ba9_0009.json", "utf8"));
const msgs = trace.messages;
const isLayer = (m: any) => m.messageId === undefined;
const convo = msgs.filter((m: any) => !isLayer(m));
let remaining = Math.max(0, 13000 - estTok(msgs.filter(isLayer).map((m: any) => m.content).join("\n")));
const kept: any[] = [];
for (let i = convo.length - 1; i >= 0; i--) {
  const t = estTok(convo[i].content);
  if (t > remaining) break;
  kept.unshift(convo[i]);
  remaining -= t;
}
while (kept.length > 0 && kept[0].role !== "user") kept.shift();
const ids = new Set(kept.map((m: any) => m.messageId));
const ctx = msgs.filter((m: any) => isLayer(m) || ids.has(m.messageId!));

// Minimal critic prompt (same shape as eval script) — but we only need to see the RAW output.
const PROMPT = `You are a strict roleplay critic. Score 2 drafts on canonFidelity (0-5) and choose a strategy (mix/stitch/rewrite). Respond with ONLY a JSON object, no prose, no fences:
{"drafts":[{"index":1,"scores":{"canonFidelity":4},"notes":"x"}],"strategy":"mix"}

--- DRAFT 1 ---
Hello world draft one.
--- DRAFT 2 ---
Hello world draft two.`;

console.log("Calling Kimi critic with short drafts + JSON instruction...\n");
const res = await generateText({
  model: nanogpt("moonshotai/kimi-k2.7-code"),
  messages: [...ctx, { role: "system", content: PROMPT }],
  maxOutputTokens: 4000,
  allowSystemInMessages: true,
});

console.log("=== RESULT ===");
console.log("finishReason:", res.finishReason);
console.log("usage:", JSON.stringify(res.usage));
console.log("text length:", res.text.length, "chars");
console.log("\n=== RAW TEXT (full) ===");
console.log(res.text);
console.log("\n=== Does it contain '{' ? ===", res.text.includes("{"));
console.log("=== Does it contain 'think' ? ===", /think/i.test(res.text));
