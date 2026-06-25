/**
 * Diagnostic: call the suspicious workers (Magnum, Anubis) directly with full logging,
 * without re-running the whole eval pipeline. Reuses the exact same context truncation +
 * provider as evaluate-agentic-swarm.ts so the conditions match.
 *
 * Prints: finishReason, usage (prompt/completion/total tokens), and a text preview — so we can
 * distinguish "hit max_tokens cap" (finishReason=length) from "model stopped on its own" (stop)
 * from "context overflow → 0 output" (length + 0 completion).
 */
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const db = new Database("../../data/vibe-tavern.db", { readonly: true });
const row = db
  .query("SELECT api_key FROM provider_profiles WHERE endpoint LIKE '%nano-gpt%' LIMIT 1")
  .get() as { api_key: string } | null;
const KEY = row?.api_key || process.env.NANO_GPT_API_KEY;
if (!KEY) {
  console.error("No NanoGPT key.");
  process.exit(1);
}
const nanogpt = createOpenAICompatible({ name: "nanogpt", apiKey: KEY, baseURL: "https://nano-gpt.com/api/v1" });
const TRACE = "c:/Users/user/Downloads/prompt-payload-trace_b955dc655ba9_0009.json";

// Same truncation as the eval script (chars/4, target 13k, snap to user turn).
const estTok = (s: string): number => Math.ceil(s.length / 4);
const TARGET = 13000;

function truncate(msgs: { role: string; content: string; messageId?: string }[]) {
  const isLayer = (m: { messageId?: string }) => m.messageId === undefined;
  const layers = msgs.filter(isLayer);
  const convo = msgs.filter((m) => !isLayer(m));
  let remaining = Math.max(0, TARGET - estTok(layers.map((m) => m.content).join("\n")));
  const kept: typeof convo = [];
  for (let i = convo.length - 1; i >= 0; i--) {
    const t = estTok(convo[i].content);
    if (t > remaining) break;
    kept.unshift(convo[i]);
    remaining -= t;
  }
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();
  const ids = new Set(kept.map((m) => m.messageId));
  return msgs.filter((m) => isLayer(m) || ids.has(m.messageId!));
}

const trace = JSON.parse(readFileSync(TRACE, "utf8")) as { messages: any[] };
const ctx = truncate(trace.messages);
console.log(`Context: ${ctx.length} msgs, ~${estTok(ctx.map((m) => m.content).join("\n"))} est tokens.\n`);

const MODELS = ["anthracite-org/magnum-v4-72b", "TheDrummer/Anubis-70B-v1"];

// --- Run 1: WITHOUT maxOutputTokens (reproduce the eval-script conditions) ----------
console.log("=== Run 1: NO maxOutputTokens (matches what the eval script did) ===");
for (const model of MODELS) {
  try {
    const res = await generateText({
      model: nanogpt(model),
      messages: ctx,
      allowSystemInMessages: true,
    });
    console.log(`\n[${model}]`);
    console.log(`  finishReason: ${res.finishReason}`);
    console.log(`  usage:`, res.usage);
    console.log(`  text length: ${res.text.length} chars`);
    console.log(`  text: ${JSON.stringify(res.text.slice(0, 200))}${res.text.length > 200 ? "…" : ""}`);
  } catch (e) {
    console.log(`\n[${model}] ERROR: ${e instanceof Error ? e.message : e}`);
  }
}

// --- Run 2: WITH explicit maxOutputTokens -------------------------------------------
console.log("\n\n=== Run 2: maxOutputTokens = 2000 ===");
for (const model of MODELS) {
  try {
    const res = await generateText({
      model: nanogpt(model),
      messages: ctx,
      maxOutputTokens: 2000,
      allowSystemInMessages: true,
    });
    console.log(`\n[${model}]`);
    console.log(`  finishReason: ${res.finishReason}`);
    console.log(`  usage:`, res.usage);
    console.log(`  text length: ${res.text.length} chars`);
    console.log(`  text: ${JSON.stringify(res.text.slice(0, 300))}${res.text.length > 300 ? "…" : ""}`);
  } catch (e) {
    console.log(`\n[${model}] ERROR: ${e instanceof Error ? e.message : e}`);
  }
}
