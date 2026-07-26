/**
 * Tokenizer event-loop bench (AD-025).
 *
 * Exercises the REAL production tokenization path:
 *   warmupTokenizers() -> setTokenCountFn(countTokens) -> setModelHint(model)
 *   -> prompt-pipeline estimateTokens / estimateMessageArrayTokens
 *
 * AD-025 rejected Worker offload because warmed production tokenization stayed
 * below both thresholds. A Worker is justified only if, on realistic
 * maximum-size work, EITHER:
 *   - p95 event-loop delay exceeds 50 ms, OR
 *   - a single CPU segment (longest event-loop block) exceeds 100 ms.
 * Re-run this bench when context windows grow substantially or a heavier
 * tokenizer family is added, per AD-025's revisit trigger.
 *
 * Run: bun scripts/bench/tokenizer-event-loop.bench.ts
 */
import { setModelHint, setTokenCountFn, estimateTokens, estimateMessageArrayTokens } from "../../packages/prompt-pipeline/src/index.js";
import { countTokens, warmupTokenizers } from "../../services/api/src/infrastructure/ai/tokenizer-service.js";

const EVENT_LOOP_SAMPLE_MS = 5;
const WARMUP_CALLS = 50;

// AD-025 worker-justification thresholds (ms).
const EVENT_LOOP_P95_THRESHOLD_MS = 50;
const CPU_SEGMENT_THRESHOLD_MS = 100;

interface Scenario {
	readonly name: string;
	readonly model: string;
	readonly calls: number;
	readonly targetTokens: number;
}

const SCENARIOS: readonly Scenario[] = [
	{ name: "many-small-gpt4o", model: "gpt-4o", calls: 1000, targetTokens: 205 },
	{ name: "large-chat-gpt4o", model: "gpt-4o", calls: 100, targetTokens: 8863 },
	{ name: "large-chat-claude", model: "claude-sonnet-4-20250514", calls: 100, targetTokens: 10123 },
];

function percentile(samples: readonly number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

// Deterministic pseudo-English filler so runs are reproducible without
// shipping text fixtures. Length is calibrated against the real tokenizer.
function makeText(targetChars: number): string {
	const words = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor"];
	const parts: string[] = [];
	let length = 0;
	let index = 0;
	while (length < targetChars) {
		const word = words[index % words.length] ?? "token";
		parts.push(word);
		length += word.length + 1;
		index += 1;
	}
	return parts.join(" ");
}

function makeCalibratedMessages(targetTokens: number): { readonly messages: Array<{ content: string }>; readonly actualTokens: number } {
	const messageCount = 8;
	const perMessage = Math.ceil(targetTokens / messageCount);
	const probe = makeText(perMessage * 4);
	const probeTokens = estimateTokens(probe);
	const charsPerToken = probeTokens > 0 ? probe.length / probeTokens : 4;
	const messages = Array.from({ length: messageCount }, () => ({ content: makeText(perMessage * charsPerToken) }));
	const actualTokens = estimateMessageArrayTokens(messages);
	return { messages, actualTokens };
}

class EventLoopSampler {
	private readonly delays: number[] = [];
	private timer: Timer | null = null;
	private last = 0;

	start(): void {
		this.last = performance.now();
		this.timer = setInterval(() => {
			const now = performance.now();
			this.delays.push(Math.max(0, now - this.last - EVENT_LOOP_SAMPLE_MS));
			this.last = now;
		}, EVENT_LOOP_SAMPLE_MS);
	}

	stop(): { readonly p95: number; readonly max: number } {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		return { p95: percentile(this.delays, 0.95), max: Math.max(0, ...this.delays) };
	}
}

async function runScenario(scenario: Scenario): Promise<void> {
	setModelHint(scenario.model);
	const { messages, actualTokens } = makeCalibratedMessages(scenario.targetTokens);

	for (let i = 0; i < WARMUP_CALLS; i += 1) estimateTokens(messages[0]?.content ?? "");

	const sampler = new EventLoopSampler();
	const latencies: number[] = [];
	const rssBefore = process.memoryUsage().rss;
	sampler.start();
	const startedAt = performance.now();
	for (let i = 0; i < scenario.calls; i += 1) {
		const callStart = performance.now();
		estimateMessageArrayTokens(messages);
		latencies.push(performance.now() - callStart);
		// Yield between calls like an async request handler does — without
		// this the interval sampler starves and event-loop delay reads zero.
		await Bun.sleep(0);
	}
	const elapsedMs = performance.now() - startedAt;
	const loopStats = sampler.stop();
	const rssAfter = process.memoryUsage().rss;

	const p50 = percentile(latencies, 0.5);
	const p95 = percentile(latencies, 0.95);
	const maxSegment = Math.max(0, ...latencies);
	const throughput = Math.round((scenario.calls / elapsedMs) * 1000);
	const p95Verdict = loopStats.p95 > EVENT_LOOP_P95_THRESHOLD_MS ? "FAIL" : "ok";
	const segmentVerdict = maxSegment > CPU_SEGMENT_THRESHOLD_MS ? "FAIL" : "ok";

	console.log(`\n[${scenario.name}] model=${scenario.model} calls=${scenario.calls} (~${actualTokens} tokens/call fixture)`);
	console.log(`  call latency:      p50 ${p50.toFixed(3)} ms   p95 ${p95.toFixed(3)} ms`);
	console.log(`  event-loop delay:  p95 ${loopStats.p95.toFixed(3)} ms (${p95Verdict}, threshold ${EVENT_LOOP_P95_THRESHOLD_MS} ms)`);
	console.log(`  max CPU segment:   ${maxSegment.toFixed(3)} ms (${segmentVerdict}, threshold ${CPU_SEGMENT_THRESHOLD_MS} ms)`);
	console.log(`  throughput:        ${throughput} calls/s`);
	console.log(`  RSS delta:         ${((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)} MB (peak ${(rssAfter / 1024 / 1024).toFixed(0)} MB)`);
}

await warmupTokenizers();
setTokenCountFn(countTokens);
console.log("AD-025 tokenizer event-loop bench — worker justified only if a scenario prints FAIL.");
for (const scenario of SCENARIOS) {
	await runScenario(scenario);
}
