/**
 * Agentic Mode — Phase 0 validation harness.
 * Two-stage swarm: workers → critic → writer. Three blind legs (A baseline / B naive-mix / C rubric).
 *
 * WHAT THIS TESTS
 *   Does a rubric-aware, strategy-aware synthesizer ELEVATE a turn above both a normal single
 *   pass and a naive "merge the best parts" synth (which tends to AVERAGE instead of elevate)?
 *   Three blind legs:
 *     A. baseline       — one single-pass generation with the writer model (today's behavior).
 *     B. naive-mix swarm — N creative workers + a minimal "synthesize the best prose" synth.
 *     C. rubric swarm    — N creative workers + a CRITIC (rubric + intent + strategy, structured)
 *                          → a WRITER whose prompt branches on the chosen strategy.
 *   B and C share the SAME worker drafts (same raw material → fair comparison). The baseline uses
 *   the writer model so the swarm value is isolated (same final-stage model, with vs without the
 *   worker pipeline).
 *
 * WORKERS = creative / older RP models (the raw-material stage). CRITIC + WRITER = a constant
 * instruction-tuned model (kimi-code). The strategy→model routing feature is DISABLED here to
 * isolate the strategy variable from the model variable; flip ENABLE_STRATEGY_MODEL_ROUTING for a
 * second run once strategy is proven to matter.
 *
 * CONTEXT-WINDOW FAIRNESS
 *   All legs and all workers receive the SAME truncated context. Truncation drops the oldest
 *   conversation turns (greedily, to a token budget) so short-window creative models (e.g. a 16k
 *   Magnum) can participate. Truncation is a held-constant variable — it limits only the
 *   generalization claim ("full-context performance"), not the within-experiment comparison.
 *
 * NOTE: scripts/ is outside the typecheck gate (services/api/tsconfig.json includes only the
 * src subdirectory). This is a throwaway eval harness, not production code. The worker model
 * slugs below must resolve on the configured provider (NanoGPT) — confirm them in that
 * provider's catalog; a failed worker is caught and reported, it does not abort the run.
 */
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

// --- secrets --------------------------------------------------------------
const db = new Database("../../data/vibe-tavern.db", { readonly: true });
const row = db
  .query("SELECT api_key FROM provider_profiles WHERE endpoint LIKE '%nano-gpt%' LIMIT 1")
  .get() as { api_key: string } | null;
const NANO_GPT_API_KEY = row?.api_key || process.env.NANO_GPT_API_KEY;
if (!NANO_GPT_API_KEY) {
  console.error("FATAL ERROR: Could not find NanoGPT API key in DB and NANO_GPT_API_KEY is not set.");
  process.exit(1);
}

// --- paths ----------------------------------------------------------------
const TRACE_PATH = "c:/Users/user/Downloads/prompt-payload-trace_b955dc655ba9_0009.json";
const OUTPUT_PATH = "c:/Users/user/Downloads/swarm_evaluation_result.md";

// --- provider -------------------------------------------------------------
// NanoGPT is an OpenAI-COMPATIBLE aggregator, not real OpenAI. The native createOpenAI provider
// (ai v6) defaults to the Responses API (input/max_output_tokens/output_text), which NanoGPT serves
// unreliably — that produced the "Invalid JSON response" / 1-token-output symptoms on Magnum/Anubis.
// createOpenAICompatible forces Chat Completions (messages/max_tokens/choices[].message), which the
// raw curl confirmed NanoGPT serves correctly. Mirrors production protocol-registry.ts (createOpenAICompatible).
const nanogpt = createOpenAICompatible({
  name: "nanogpt",
  apiKey: NANO_GPT_API_KEY,
  baseURL: "https://nano-gpt.com/api/v1",
});

// --- models ---------------------------------------------------------------
// Workers: creative / older RP models (raw material). CONFIRM each slug resolves on NanoGPT.
// Note magnum-v4-72b has a 16k context window and Qwerky 32k — handled by truncation below.
const WORKER_MODELS = [
  "anthracite-org/magnum-v4-72b",                       // 16k ctx — beloved RP model, needs clean history
  "TheDrummer/Anubis-70B-v1",                          // 64k ctx
  "deepseek-ai/DeepSeek-R1-0528",                        // 128k ctx, reasoning
  "deepseek/deepseek-v4-pro:thinking",                  // v4 pro, thinking mode
  "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled",    // distilled reasoning
];
// Critic + Writer + Baseline: CONSTANT instruction-tuned model. Isolates the strategy variable.
// (Compliance model for the critic's structured output; not a thinking model — those flake on JSON mode.)
const CRITIC_MODEL = "moonshotai/kimi-k2.7-code";
const WRITER_MODEL = "moonshotai/kimi-k2.7-code";
const BASELINE_MODEL = WRITER_MODEL; // isolates swarm value: same final-stage model, ± the worker pipeline
const NAIVE_SYNTH_MODEL = WRITER_MODEL;

// === STRATEGY → MODEL ROUTING (DISABLED FOR FIRST EXPERIMENT) ============
// Hypothesis: rewrite (heaviest) → strongest prose model; mix (mechanical) → cheaper model.
// Enable only in a second run, AFTER strategy is proven to affect quality, so the two variables
// (strategy, model) are not confounded.
const ENABLE_STRATEGY_MODEL_ROUTING = false;
const STRATEGY_MODEL_MAP: Record<Strategy, string> = {
  stitch: "moonshotai/kimi-k2.7-code",
  rewrite: "moonshotai/kimi-k2.7-code", // swap in a stronger prose model to test routing
};
const writerModelFor = (s: Strategy): string =>
  ENABLE_STRATEGY_MODEL_ROUTING ? STRATEGY_MODEL_MAP[s] : WRITER_MODEL;

// --- experiment toggles ---------------------------------------------------
const INCLUDE_NAIVE_MIX_LEG = true;

// --- context truncation ---------------------------------------------------
// Target input budget for the SHARED context (history + system layers), in estimated tokens.
// Sized for the smallest worker window: Magnum 16k − ~3k generation headroom ≈ 13k.
// The chars/4 estimate over-reports ~9% (calibrated against this trace: 23160 est vs 21300 real),
// so 13000 est ≈ 11.9k real — safely under 16k with headroom to spare. Tune down if a 16k worker truncates.
const TARGET_CONTEXT_TOKENS = 13000;
const CHARS_PER_TOKEN = 4; // calibrated: slightly conservative for this RU/JP-mixed trace

// --- constraint block (generic canon — NOT scene-specific) ----------------
// In production this is ASSEMBLED from persona / active lore / chat settings by the orchestrator,
// never hand-written per scene. The original script's flaw was baking the SCENE'S answer in
// ("Noi's dialogue is hyper-empathic... Oki must perceive it as such") — a cheat that tests whether
// a human can write a good instruction, not whether the swarm works. This block re-asserts only
// CHARACTER CANON rules + rules of engagement, which is what production would send.
const CONSTRAINT_BLOCK = `<canon — non-negotiable>
Character: Oki Shima. Voice/register rule (THE DECIDING AXIS): "Aggressive Devotion" — he expresses
affection through terrifying dominance and heavy, suffocating control. His emotional surrender to Noi
is REAL, but it must surface as possessive, controlling, monstrous physical expression — NOT as
tenderness-without-teeth, NOT as a vanilla/subservient boyfriend, NOT as a reformed/softened villain.
Tender gestures cost him visible effort and are immediately counterweighted by control. If a response
makes Oki soft, docile, grateful, boyfriend-like, or "learns to be tender", it FAILS canon — no matter
how strong its psychology or prose.
Active lore (do not contradict): Hyper-POTS (adrenergic; tachycardic but NEVER faints; resting 60–70,
sexual activity 110–120); Hypermobility (knees subluxate, osteoarthritic hips, stiff non-hyperextending
fingers, doughy elastic skin); MCAS (only long-contact mild skin irritation or rhinitis, NEVER
anaphylaxis); Oki's tentacles extrude from any point, conceal without a trace, and reflexively protect
Noi's joints even when he is startled, hostile, or emotionally overwhelmed.
</canon>
<rules>
- NO PUPPETING: write ONLY Oki's perspective, dialogue, actions, and thoughts. Never write Noi's
  dialogue, actions, or inner state.
- BANNED WORDS: testament, shivers, labyrinth, tapestry, symphony, dance, cacophony.
- FORBIDDEN TROPES: "no one ever [did X for me]" and "[the user] sees me differently" — cheap, banned.
- Perspective/tense: 3rd person, past tense (match the drafts and prior turns).
</rules>`;

// --- critic schema + prompt ----------------------------------------------
type Strategy = "stitch" | "rewrite";

const criticSchema = z.object({
  intent: z
    .string()
    .describe("One sentence: what the user's last message dramatically asks for / the core of this turn."),
  drafts: z.array(
    z.object({
      index: z.number().int().describe("1-based draft index."),
      scores: z.object({
        psychology: z.number().min(0).max(5).describe("Internal logic, motives, dramatic core."),
        canonFidelity: z
          .number()
          .min(0)
          .max(5)
          .describe("Adherence to Oki's voice/register per the canon block. A DECIDING AXIS — a voice break overrides strong psychology/prose."),
        dialogue: z
          .number()
          .min(0)
          .max(5)
          .describe("Do the spoken lines sound like spontaneous speech a real person would produce in this state, or like over-polished 'literary' dialogue? Low = lacquered/written-sounding."),
        lore: z.number().min(0).max(5).describe("Correctness vs POTS / hypermobility / MCAS / tentacle biology."),
        anatomy: z.number().min(0).max(5).describe("Physical plausibility (tentacles, joints, bodies)."),
        sceneDetail: z.number().min(0).max(5).describe("Sensory / atmospheric grounding."),
      }),
      canonFailure: z
        .boolean()
        .describe("True if this draft breaks OKI's voice/register (soft/boyfriend-like/tender-without-teeth). The prose itself is wrong-colored → forces rewrite, cannot be lifted verbatim."),
      puppeting: z
        .boolean()
        .describe("True if this draft writes NOI's dialogue, actions, or inner state (steals the user's turn). NOT an auto-fail — spatially separable: Oki's material is fine, only Noi's lines must be cut. Name the exclusions in the plan."),
      notes: z.string().describe("What this draft does well and where it fails, especially canon/register failures and any puppeting."),
    }),
  ),
  strategy: z
    .enum(["stitch", "rewrite"])
    .describe(
      "BINARY keyed on prose-salvageability. stitch: drafts' prose is salvageable (voice in register, dialogue natural) → assemble the named passages with voice-normalized seams (default). rewrite: drafts' prose is NOT salvageable (canonFailure / lacquered dialogue) → keep ideas/beats from the plan, write from scratch in correct voice + naturalistic dialogue. There is no 'mix': merging compatible drafts is naive-merge (no lift) and it degrades dialogue into a catalogue monologue, so it was removed.",
    ),
  strategyRationale: z.string(),
  plan: z
    .string()
    .describe("Concrete directive to the writer: which passages or ideas to lift from which draft (by index), or what to rewrite, and the exact register required."),
});

const CRITIC_PROMPT = `You are a strict roleplay critic. The full scene context appears first, then ${WORKER_MODELS.length} drafts of the NEXT turn.

Score each draft 0–5 on six axes. canonFidelity is a DECIDING axis and OVERRIDES the others: a draft that breaks Oki's voice/register (soft, boyfriend-like, tender-without-teeth, "learns to be tender") must score low on canonFidelity, and you MUST set canonFailure=true for it — do NOT let strong psychology or prose rescue an out-of-character draft.

Axes:
- psychology: internal logic, motives, the dramatic core of the turn (recognition, possession, etc.).
- canonFidelity: adherence to Oki's voice/register per the canon block. A DECIDING AXIS.
- dialogue: do the SPOKEN LINES sound like spontaneous speech a real person would actually produce in this state, or like over-polished "literary"/written dialogue? Big models tend to lacquer dialogue (smooth, complete, composed); reward rough, broken, situationally-stressed speech that a person would actually say. Low score for lines that read like prose-with-quotation-marks.
- lore: correctness vs active lore (POTS / hypermobility / MCAS / tentacle biology).
- anatomy: physical plausibility (tentacles, joints, bodies).
- sceneDetail: sensory / atmospheric grounding.

PUPPETING (separate from canonFailure): if a draft writes Noi's dialogue, actions, or inner state, set puppeting=true. This is NOT an auto-fail and does NOT lower canonFidelity — the draft's Oki material may be excellent and worth lifting. Puppeting is spatially separable: salvage the Oki prose/imagery/psychology, and in the plan explicitly name the Noi lines to EXCLUDE. A draft can be both canonFailure=false (Oki is in voice) and puppeting=true (but it stole Noi's turn) — flag both honestly.

canonFailure vs puppeting, restated: canonFailure means the prose is wrong-colored (soft Oki) → must rewrite, can't lift verbatim. puppeting means the speaker assignment is wrong (it wrote Noi) → can lift the Oki parts under any strategy, just cut Noi's lines.

Then choose a synthesis strategy — a BINARY decision keyed on whether the drafts' PROSE is good enough to lift verbatim:
- "stitch": the drafts' prose is salvageable — voice is in register and dialogue is natural (not lacquered). Assemble the named passages into one continuous response with seamless voice-normalized transitions (default; choose this unless prose must be discarded). When drafts already agree in register, the normalization is a harmless safety net.
- "rewrite": the drafts' prose is NOT salvageable — canonFailure is true (wrong voice) OR dialogue is uniformly lacquered/written-sounding. Keep the ideas/beats from the plan, write from scratch in the correct voice with naturalistic (rough, situationally-stressed) dialogue. Do not lift prose verbatim.
There is NO "mix" option. Merging compatible drafts is what a naive synth already does — it adds no editorial lift and tends to flatten dialogue into a catalogue monologue. If drafts are compatible and strong, that is still "stitch".

Then give the writer a CONCRETE plan: which passages/ideas to lift from which draft (by index), or what to rewrite from scratch, and the exact register required. If any draft you lift from has puppeting=true, the plan MUST explicitly say which Noi lines/passages to EXCLUDE — never carry stolen partner lines into the final turn.

Respond with ONLY a JSON object (no prose, no markdown fences). Match this exact shape:
{
  "intent": "one sentence",
  "drafts": [
    { "index": 1, "scores": { "psychology": 0-5, "canonFidelity": 0-5, "dialogue": 0-5, "lore": 0-5, "anatomy": 0-5, "sceneDetail": 0-5 }, "canonFailure": true_or_false, "puppeting": true_or_false, "notes": "..." }
  ],
  "strategy": "stitch" | "rewrite",
  "strategyRationale": "...",
  "plan": "..."
}
Score ALL ${WORKER_MODELS.length} drafts — exactly one drafts[] entry per draft, in order. Output the JSON and nothing else.`;

// --- writer prompt (branches on strategy) --------------------------------
const STRATEGY_INSTRUCTION: Record<Strategy, string> = {
  stitch: `Strategy = STITCH. The drafts' prose is salvageable (voice in register, dialogue natural). Assemble the named passages into one continuous response, writing seamless transitions between them and NORMALIZING the voice so the seams vanish. Every passage must end up in Oki's canonical voice — if a passage you are keeping is too soft, harden it at the seam; if its dialogue reads polished/written, roughen it. Do not introduce new plot beats. Do not mention or reference the drafts. ABSOLUTE RULE: write ONLY Oki — never write Noi's dialogue, actions, or inner state. The plan names Noi lines to EXCLUDE from lifted passages; cut them entirely; the user plays Noi.`,
  rewrite: `Strategy = REWRITE. The drafts' prose is NOT salvageable: voice/register is off (canon warnings) OR dialogue is uniformly lacquered/written-sounding. Keep the ideas and dramatic beats named in the plan, but write the response FROM SCRATCH in the correct character voice with naturalistic (rough, broken, situationally-stressed — NOT polished) dialogue. Do NOT lift prose verbatim from any draft. Do not mention or reference the drafts. ABSOLUTE RULE: write ONLY Oki — never write Noi's dialogue, actions, or inner state; the user plays Noi.`,
};

// --- naive-mix synth prompt (leg B — intentionally minimal) --------------
const NAIVE_MIX_PROMPT = `Below are ${WORKER_MODELS.length} drafts of the next roleplay turn. Synthesize the best prose, sensory details, and atmospheric tension from them into one response. Stay in character. Do not reference the drafts.`;

// --- helpers --------------------------------------------------------------
const BANNED_WORDS = ["testament", "shivers", "labyrinth", "tapestry", "symphony", "dance", "cacophony"];

interface TraceMsg {
  role: string;
  content: string;
  layerId?: string;
  messageId?: string;
}

const estTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);
const stripThink = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
const scanBanned = (text: string): string[] => {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => lower.includes(w));
};
const buildDraftsText = (drafts: string[]): string =>
  drafts.map((d, i) => `\n\n--- DRAFT ${i + 1} ---\n${d}`).join("");

/**
 * Truncate the trace to a shared token budget. Keeps ALL system/layer messages (persona, lore,
 * examples, rules) in place; drops the OLDEST conversation turns (those with a messageId) greedily
 * until the estimate fits. Snaps the kept history to start on a user turn (natural RP boundary).
 * Returns the filtered message list + an audit of what was dropped.
 */
function truncateToBudget(msgs: TraceMsg[], target: number): {
  messages: TraceMsg[];
  dropped: TraceMsg[];
  estTokens: number;
} {
  const isLayer = (m: TraceMsg): boolean => m.messageId === undefined;
  const layers = msgs.filter(isLayer);
  const convo = msgs.filter((m) => !isLayer(m)); // chronological

  const layerTokens = estTokens(layers.map((m) => m.content).join("\n"));
  let remaining = Math.max(0, target - layerTokens);

  // Walk convo newest→oldest, keep until budget exhausted.
  const kept: TraceMsg[] = [];
  for (let i = convo.length - 1; i >= 0; i--) {
    const t = estTokens(convo[i].content);
    if (t > remaining) break;
    kept.unshift(convo[i]);
    remaining -= t;
  }
  // Snap to a user-turn start so the kept history opens naturally.
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();

  const keptIds = new Set(kept.map((m) => m.messageId));
  const dropped = convo.filter((m) => !keptIds.has(m.messageId));
  // Reassemble preserving original interleaving (layers stay in place, incl. trailing ones).
  const messages = msgs.filter((m) => isLayer(m) || keptIds.has(m.messageId!));
  return { messages, dropped, estTokens: estTokens(messages.map((m) => m.content).join("\n")) };
}

async function genText(
  model: string,
  messages: unknown[],
  tag: string,
  maxOutputTokens?: number,
): Promise<string> {
  console.log(`  [${tag}] generating (${model})...`);
  try {
    const res = await generateText({
      model: nanogpt(model),
      messages: messages as never,
      allowSystemInMessages: true,
      // maxOutputTokens omitted unless explicitly passed. Kimi (writer/baseline/critic) is
      // reasoning-heavy and a tight cap truncates the final answer mid-sentence (happened in the
      // last run: rubric-swarm leg ended on "...her knees could not"). Workers keep a cap because
      // some have a small context window (Magnum 16k) — without it, input + output overflows.
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
    console.log(`  [${tag}] done.`);
    return stripThink(res.text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  [${tag}] FAILED: ${msg}`);
    return `[FAILED TO GENERATE: ${msg}]`;
  }
}

/**
 * Extract a JSON object from raw model text. Mirrors the production pattern in
 * ai-assistant-stream.ts (extractJsonFromText): markdown fence → outermost {…} via brace
 * matching (string/escape aware) → whole text. The aggregator is unreliable with the AI SDK's
 * structured-output mode, so the critic emits plain text and we parse it here.
 */
function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s.trim());
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    const p = tryJson(fence[1]);
    if (p) return p;
  }
  const first = text.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return tryJson(text.slice(first, i + 1));
    }
  }
  return tryJson(text);
}

// --- main -----------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Loading trace...");
  const trace = JSON.parse(readFileSync(TRACE_PATH, "utf8")) as { messages: TraceMsg[] };
  const rawMessages = trace.messages;

  // ---- shared truncated context (all legs, all workers) ----------------
  const { messages: ctx, dropped, estTokens: ctxTokens } = truncateToBudget(rawMessages, TARGET_CONTEXT_TOKENS);
  console.log(`\nShared context: ~${ctxTokens} est tokens (target ${TARGET_CONTEXT_TOKENS}).`);
  console.log(`  Kept ${ctx.length} messages. Dropped ${dropped.length} oldest conversation turn(s):`);
  for (const d of dropped) console.log(`    - [${d.role}] ${d.messageId} (~${estTokens(d.content)} tok)`);

  // ---- shared workers (B and C use the same drafts) ---------------------
  console.log("\n=== Stage 1: workers (shared by legs B & C) ===");
  const drafts: string[] = [];
  for (let i = 0; i < WORKER_MODELS.length; i++) {
    drafts.push(await genText(WORKER_MODELS[i], [...ctx], `worker ${i + 1}`, 3000));
  }
  const draftsText = buildDraftsText(drafts);

  // ---- leg A: baseline --------------------------------------------------
  console.log("\n=== Leg A: baseline (single pass) ===");
  const baseline = await genText(BASELINE_MODEL, [...ctx], "baseline");

  // ---- leg B: naive-mix swarm ------------------------------------------
  let naiveMix = "[naive-mix leg disabled]";
  if (INCLUDE_NAIVE_MIX_LEG) {
    console.log("\n=== Leg B: naive-mix swarm ===");
    naiveMix = await genText(
      NAIVE_SYNTH_MODEL,
      [...ctx, { role: "system", content: `${NAIVE_MIX_PROMPT}${draftsText}` }],
      "naive-synth",
    );
  }

  // ---- leg C: rubric swarm (critic → writer) ---------------------------
  console.log("\n=== Leg C: rubric swarm — critic ===");
  let criticVerdict: z.infer<typeof criticSchema> | null = null;
  try {
    // The aggregator (NanoGPT) is unreliable with the AI SDK's structured-output mode
    // (Output.object / function-calling) — documented in ai-assistant-stream.ts:251 for md_import.
    // Same fix as production: plain generateText + manual JSON extraction from the text.
    // Budget 6000: 5 drafts × (scores + prose notes) is a verbose JSON object; 4000 truncated it
    // mid-stream in the first run → brace matching found no closing brace → "No JSON object found".
    const criticRes = await generateText({
      model: nanogpt(CRITIC_MODEL),
      messages: [
        ...ctx,
        { role: "system", content: `${CONSTRAINT_BLOCK}\n\n${CRITIC_PROMPT}${draftsText}` },
      ] as never,
      allowSystemInMessages: true,
      // No maxOutputTokens: Kimi (critic) is reasoning-heavy and a cap truncated its JSON
      // mid-stream in an earlier run (→ "No JSON object found"). Let the provider default apply.
    });
    const extracted = extractJsonObject(stripThink(criticRes.text));
    if (!extracted) throw new Error("No JSON object found in critic response.");
    const parsed = criticSchema.safeParse(extracted);
    if (!parsed.success) {
      throw new Error(
        `Critic JSON failed schema validation: ${JSON.stringify(parsed.error.issues).slice(0, 300)}`,
      );
    }
    criticVerdict = parsed.data;
    console.log(
      `  critic chose strategy="${criticVerdict.strategy}" → writer model="${writerModelFor(criticVerdict.strategy)}"`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  critic FAILED: ${msg}`);
  }

  let rubric = "[critic failed — no rubric output]";
  if (criticVerdict) {
    const strategy = criticVerdict.strategy;
    const scoresTable = criticVerdict.drafts
      .map((d) => {
        const s = d.scores;
        const flags = `${d.canonFailure ? "  ⚠ CANON FAIL" : ""}${d.puppeting ? "  ✂ PUPPETING" : ""}`;
        return `  Draft ${d.index}: psych ${s.psychology} · canon ${s.canonFidelity} · dialogue ${s.dialogue} · lore ${s.lore} · anatomy ${s.anatomy} · scene ${s.sceneDetail}${flags}`;
      })
      .join("\n");

    const writerDirective =
      `${CONSTRAINT_BLOCK}\n\n` +
      `Here are the drafts:${draftsText}\n\n` +
      `CRITIC VERDICT\n` +
      `Intent: ${criticVerdict.intent}\n` +
      `Strategy: ${strategy} — ${criticVerdict.strategyRationale}\n` +
      `Per-draft scores (canonFidelity is the deciding axis):\n${scoresTable}\n\n` +
      `Plan for the writer:\n${criticVerdict.plan}\n\n` +
      `${STRATEGY_INSTRUCTION[strategy]}\n\n` +
      `Write the single final version of the turn now.`;

    console.log("\n=== Leg C: rubric swarm — writer ===");
    rubric = await genText(
      writerModelFor(strategy),
      [...ctx, { role: "system", content: writerDirective }],
      `writer(${strategy})`,
    );
  }

  // ---- assemble blind report -------------------------------------------
  type Leg = { label: string; text: string; model: string };
  const legs: Leg[] = [
    { label: "Baseline (single pass)", text: baseline, model: BASELINE_MODEL },
    ...(INCLUDE_NAIVE_MIX_LEG
      ? [{ label: "Naive-mix swarm (workers + dumb synth)", text: naiveMix, model: NAIVE_SYNTH_MODEL }]
      : []),
    {
      label: criticVerdict
        ? `Rubric swarm (workers → critic → writer, strategy=${criticVerdict.strategy})`
        : "Rubric swarm (critic failed)",
      text: rubric,
      model: criticVerdict ? writerModelFor(criticVerdict.strategy) : WRITER_MODEL,
    },
  ];

  const shuffled = [...legs].sort(() => Math.random() - 0.5);
  const letters = ["A", "B", "C"];
  const sections = shuffled
    .map((leg, i) => `## Option ${letters[i]}\n*(${leg.label})*\n\n${leg.text}`)
    .join("\n\n---\n\n");
  const answerKey = shuffled.map((leg, i) => `Option ${letters[i]} = ${leg.label}`).join("\n");

  const bannedReport = legs
    .map((leg) => {
      const hits = scanBanned(leg.text);
      return `- ${leg.label}: ${hits.length ? hits.join(", ") : "none"}`;
    })
    .join("\n");

  let criticReport = "_Critic failed — no structured verdict._";
  if (criticVerdict) {
    const rows = criticVerdict.drafts
      .map((d) => {
        const s = d.scores;
        const flag = `${d.canonFailure ? "⚠" : ""}${d.puppeting ? "✂" : ""}`;
        return `| ${d.index} | ${s.psychology} | ${s.canonFidelity} | ${s.dialogue} | ${s.lore} | ${s.anatomy} | ${s.sceneDetail} | ${flag} |`;
      })
      .join("\n");
    criticReport =
      `**Intent:** ${criticVerdict.intent}\n\n` +
      `**Strategy:** \`${criticVerdict.strategy}\` — ${criticVerdict.strategyRationale}\n\n` +
      `**Per-draft scores** (canonFidelity decides; ✂ = puppeting = salvage Oki, cut Noi; ⚠ = canonFailure = rewrite):\n\n` +
      `| draft | psych | canon | dialogue | lore | anatomy | scene | flags |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
      `**Plan handed to the writer:**\n\n${criticVerdict.plan}\n`;
  }

  const report = `# Agentic Mode — Phase 0 (two-stage swarm: workers → critic → writer)

Three blind legs. B and C share the same worker drafts and the SAME truncated context as A.
Pick the best response for the turn, then reveal the key. The diagnostics show what the critic
decided (the point of this run).

${sections}

---

<details>
<summary>Answer Key (click to reveal)</summary>

${answerKey}
</details>

---

## Diagnostics

### Shared context (truncated for fairness)
- Target: ${TARGET_CONTEXT_TOKENS} est tokens (sized for the smallest worker window — Magnum 16k).
- Kept: ~${ctxTokens} est tokens, ${ctx.length} messages. Dropped ${dropped.length} oldest conversation turn(s)
  (the early explicit scene), keeping the emotional arc into the target turn.
- All legs and all workers received this identical context.

### Critic verdict (the mechanism under test)
${criticReport}

### Strategy → model routing
- Feature status: **${ENABLE_STRATEGY_MODEL_ROUTING ? "ENABLED" : "DISABLED (isolating the strategy variable)"}**
- Writer model used: **${criticVerdict ? writerModelFor(criticVerdict.strategy) : WRITER_MODEL}** (constant across strategies in this run)
- Map when enabled: stitch → \`${STRATEGY_MODEL_MAP.stitch}\` · rewrite → \`${STRATEGY_MODEL_MAP.rewrite}\`

### Banned-word scan (per leg)
${bannedReport}

### Models used
- Workers (shared): ${WORKER_MODELS.join(", ")}
- Baseline / naive-synth / critic / writer: ${WRITER_MODEL} (constant)

### How to read this
- If **Rubric swarm** beats **Naive-mix swarm**, the critic's rubric+strategy is the lift (not just "more models").
- If **Naive-mix** already beats baseline but **Rubric** beats Naive-mix, the critic→writer split adds a real second lever on top of raw parallelism.
- Watch the **canonFidelity** column: drafts that score high on psychology but low on canon (⚠) are exactly the "strong ideas, wrong voice" cases that only \`rewrite\` can fix — a naive mix would blend that failure in.
- Watch the **dialogue** column: if the synth (Kimi, instruction-tuned) scores LOWER on dialogue than the worker drafts it lifted from, the synth pass itself is lacquering the speech — a real cost of centralizing prose in a big model. If workers are low on dialogue too, the model pool is the problem, not the architecture.
- Watch the **puppeting** flag: a flagged draft was SALVAGED (Oki material lifted, Noi lines cut per the plan), not discarded. If the final rubric-swarm response still contains Noi dialogue/actions, the writer ignored the plan's exclusion directive — a writer-compliance failure, not a critic failure. Compare against the baseline: in the prior run BOTH baseline AND rubric-swarm puppeted, while naive-mix did not — which is why puppeting is now a first-class flag rather than an afterthought.
`;

  writeFileSync(OUTPUT_PATH, report, "utf8");
  console.log(`\nDone! Report written to ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
