/**
 * Bench #4 — end-to-end importJson lean vs non-lean, through the REAL SessionRuntime.
 *
 * Bench #3 measured the raw cost of `mapChatToListItem` in isolation. It proves
 * the DIAGNOSIS (getSnapshot's chat-list rebuild is O(N)) but cannot detect a
 * regression in `importJson` itself — if someone re-introduces a `getSnapshot`
 * call into the lean path, bench #3 does not blink.
 *
 * This bench closes that gap. It spins up a REAL `SessionRuntime` (real SQLite
 * stores, real chatOrder, real `getSnapshot` that rebuilds the chat list over
 * ALL chatOrder.items) and imports N unique character cards via the production
 * `runtime.importJson(...)` code path — once with `lean: true`, once without.
 *
 * Expected shape (the Wave 1 contract):
 *   - non-lean: O(N²) cumulative — each import's getSnapshot reads all prior
 *     chats, and chatOrder grows by 1 per import. Total time grows super-linearly.
 *   - lean: flat / near-zero — getSnapshot is never called; per-import cost is
 *     just the character+chat insert.
 *
 * Regression gate: if the `lean` flag stops disabling getSnapshot, the lean
 * numbers spike to match non-lean and the ratio collapses. Eyeball the ratio
 * printed at the end; it should be >10× on any reasonable disk.
 *
 * Modeled on the createTestRuntime helper in coauthor-chat-api.test.ts.
 */
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../../services/api/src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../../services/api/src/runtime/session/session-runtime.js";
import { setTokenCountFn } from "../../packages/prompt-pipeline/src/index.js";

const N = 200; // cards per run — enough to show the curve, fast for a gate

function fmt(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(1)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

async function createRuntime(): Promise<{
	runtime: SessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-bench4-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	return {
		runtime,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

/** Build N unique V2 cards (unique names → unique deterministic ids → create path). */
function makeCards(n: number): { fileName: string; jsonText: string }[] {
	const out: { fileName: string; jsonText: string }[] = [];
	for (let i = 0; i < n; i++) {
		const name = `BenchChar_${i}_${crypto.randomUUID().slice(0, 6)}`;
		out.push({
			fileName: `${name}.json`,
			jsonText: JSON.stringify({
				spec: "chara_card_v2",
				spec_version: "2.0",
				data: { name, description: "stub" },
			}),
		});
	}
	return out;
}

async function runImportLoop(label: string, lean: boolean): Promise<{
	totalMs: number;
	firstMs: number; // per-card cost when chatOrder is small
	lastMs: number; // per-card cost when chatOrder is large (O(N) getSnapshot)
	medianMs: number; // robust central tendency (insulates from one-off outliers)
}> {
	const { runtime, cleanup } = await createRuntime();
	const cards = makeCards(N);

	// assemble.ts logs every prompt assembly via bare console.log (a named defect,
	// out of scope for Wave 1), and createRuntimeStore prints [db] lines. Silence
	// console.log for the whole loop+setup, restore for reporting. Bun's console
	// bypasses process.stdout.write, so we must swap the function itself.
	const realLog = console.log;
	console.log = (() => {}) as never;

	try {
		// Warmup: a few cards outside the measurement so JIT, file-cache, and DB
		// connection setup settle. Discarded from the numbers. Without this, the
		// first measured card pays one-off costs that distort the absolute total.
		const warmup = makeCards(8);
		for (const c of warmup) {
			await runtime.importJson({ ...c, skipExisting: true, lean });
		}

		const samples: number[] = [];
		let firstMs = 0;
		let lastMs = 0;
		const tStart = Bun.nanoseconds();
		for (let i = 0; i < cards.length; i++) {
			const t0 = Bun.nanoseconds();
			await runtime.importJson({ ...cards[i], skipExisting: true, lean });
			const ms = (Bun.nanoseconds() - t0) / 1_000_000;
			samples.push(ms);
			if (i === 0) firstMs = ms;
			if (i === cards.length - 1) lastMs = ms;
		}
		const totalMs = (Bun.nanoseconds() - tStart) / 1_000_000;
		samples.sort((a, b) => a - b);
		const medianMs = samples[Math.floor(samples.length / 2)];
		return { totalMs, firstMs, lastMs, medianMs };
	} finally {
		console.log = realLog;
		await cleanup();
	}
}

async function main() {
	// Prompt-pipeline needs a token counter for assembleContextPreview inside
	// getSnapshot. A char-length stub is enough (matches the test helper).
	setTokenCountFn((text: string) => text.length);

	console.log(`Bench #4 — end-to-end importJson lean vs non-lean (REAL SessionRuntime).`);
	console.log(`Importing ${N} unique cards per run. Non-lean pays getSnapshot on every call;`);
	console.log(`chatOrder grows by 1 per import, so non-lean cumulative is O(N²). Lean skips it.`);
	console.log("");

	const nonLean = await runImportLoop("non-lean", false);
	const lean = await runImportLoop("lean", true);

	console.log("");
	console.log("─── Results ───");
	console.log(`  non-lean  | total: ${fmt(nonLean.totalMs).padStart(9)} | per-card first→last: ${fmt(nonLean.firstMs).padStart(8)} → ${fmt(nonLean.lastMs).padStart(8)} | median: ${fmt(nonLean.medianMs).padStart(8)} | (getSnapshot every call)`);
	console.log(`  lean      | total: ${fmt(lean.totalMs).padStart(9)} | per-card first→last: ${fmt(lean.firstMs).padStart(8)} → ${fmt(lean.lastMs).padStart(8)} | median: ${fmt(lean.medianMs).padStart(8)} | (getSnapshot skipped)`);
	console.log("");
	console.log("─── Wave 1 win (absolute) ───");
	const ratio = nonLean.totalMs / lean.totalMs;
	console.log(`  Total: lean is ${ratio.toFixed(1)}× faster (${fmt(nonLean.totalMs)} → ${fmt(lean.totalMs)}).`);
	console.log("");
	console.log("─── Regression gate (disk-independent: per-card growth ratio) ───");
	// The robust signal. Non-lean pays O(N) getSnapshot per call, so its per-card
	// cost grows with chatOrder: last/first > 2 confirms the O(N) per call. Lean
	// skips getSnapshot entirely, so last/first stays flat (≈1). If a regression
	// re-introduces getSnapshot into the lean path, lean's growth spikes toward
	// non-lean's and the gate fails — regardless of disk speed.
	const nonLeanGrowth = nonLean.lastMs / nonLean.firstMs;
	const leanGrowth = lean.lastMs / lean.firstMs;
	console.log(`  non-lean per-card growth (last/first): ${nonLeanGrowth.toFixed(2)}×  (expect > 2 = O(N) per call confirmed)`);
	console.log(`  lean per-card growth     (last/first): ${leanGrowth.toFixed(2)}×  (expect ≈ 1 = flat)`);
	const pass = nonLeanGrowth > 2 && leanGrowth < 1.5;
	console.log(`  Gate: ${pass ? "PASS ✓" : "FAIL ✗ — lean growth no longer flat; investigate the lean flag"}`);
	console.log("");
	console.log(`Extrapolation to the reported 1300-card case (non-lean scales ~O(N²)):`);
	console.log(`  non-lean ≈ ${(nonLean.totalMs * (1300 / N) * (1300 / N) / 1000).toFixed(0)}s+ on this disk;`);
	console.log(`  lean ≈ ${(lean.totalMs * (1300 / N) / 1000).toFixed(1)}s (linear).`);
}

await main();
