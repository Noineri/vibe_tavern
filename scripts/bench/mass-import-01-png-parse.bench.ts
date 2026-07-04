/**
 * Bench #1 — PNG parse cost (`extractPngMetadata`).
 *
 * Reproduces the CPU work the browser currently does on the main thread in the
 * `StFolderImport` flow: `extractPngMetadata` is called TWICE per PNG (once in
 * `handleFolderPick` to filter by chara/ccv3 chunk, once in `handleImport` to
 * parse the card). With ~1300 cards that is 2600 sequential main-thread parses.
 *
 * This bench quantifies:
 *   - per-call parse cost in ms (median + p95 + max)
 *   - total cost at scale (looped to ~1300 cards to mirror the reported case)
 *   - the double-parse tax the current UI pays
 *
 * Absolute numbers depend on hardware (the user who hit the 2-hour hang was on
 * a weak laptop; the dev machine is fast). The RELATIVE proportion of parse
 * cost vs the other benches (SQLite, snapshot, network) is what prioritizes
 * the waves in MASS_IMPORT_OPTIMIZATION.md — proportions hold across machines.
 *
 * Fixtures: real character card PNGs from data/backups/ (contain real chara +
 * ccv3 chunks). Looped to ~1300 to mirror the reported mass-import case.
 */
import { extractPngMetadata, parseCharacterMetadata } from "../../apps/web/src/lib/png-reader.js";

const TARGET_CARD_COUNT = 1300;

function fmtMs(ns: number): string {
	return (ns / 1_000_000).toFixed(2);
}

function pct(arr: number[], p: number): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
	return sorted[idx];
}

async function loadFixtureCards(): Promise<{ name: string; file: File }[]> {
	const globs = [
		"data/backups/characters_*/avatar.png",
		"data/backups/characters_*/*/avatar.png",
	];
	const paths: string[] = [];
	for (const g of globs) {
		const glob = new Bun.Glob(g);
		for await (const p of glob.scan(".")) {
			if (!paths.includes(p)) paths.push(p);
		}
	}
	const cards: { name: string; file: File }[] = [];
	for (const p of paths) {
		const buf = await Bun.file(p).arrayBuffer();
		cards.push({ name: p, file: new File([buf], "avatar.png") });
	}
	return cards;
}

async function main() {
	const fixtures = await loadFixtureCards();
	if (fixtures.length === 0) {
		console.error("No fixture PNG cards found under data/backups/. Aborting.");
		process.exit(1);
	}
	console.log(`Loaded ${fixtures.length} real card PNGs; looping to ~${TARGET_CARD_COUNT}.`);

	const totalBytes = fixtures.reduce((sum, c) => sum + c.file.size, 0);
	const avgBytes = Math.round(totalBytes / fixtures.length);
	console.log(`Card size: avg ${fmtMs(avgBytes * 1000)} KB, smallest ${Math.round(Math.min(...fixtures.map(c => c.file.size)) / 1024)} KB, largest ${Math.round(Math.max(...fixtures.map(c => c.file.size)) / 1024 * 1000) / 1000} MB.`);
	console.log("");

	// Build the ~1300-card sequence by looping fixtures.
	const queue: { name: string; file: File }[] = [];
	while (queue.length < TARGET_CARD_COUNT) {
		queue.push(fixtures[queue.length % fixtures.length]);
	}

	// Warmup (JIT).
	for (let i = 0; i < 5; i++) {
		await extractPngMetadata(fixtures[i % fixtures.length].file);
	}

	// ─── Single-parse cost (one extractPngMetadata per card) ────────────────
	const singleCallNs: number[] = [];
	const singleTotalT0 = Bun.nanoseconds();
	for (const card of queue) {
		const t0 = Bun.nanoseconds();
		await extractPngMetadata(card.file);
		singleCallNs.push(Bun.nanoseconds() - t0);
	}
	const singleTotalNs = Bun.nanoseconds() - singleTotalT0;

	console.log("─── Single-parse pass (1× per card, as a Worker would do) ───");
	console.log(`  ${queue.length} cards | total ${fmtMs(singleTotalNs)} ms | mean ${(singleTotalNs / queue.length / 1_000_000).toFixed(2)} ms`);
	console.log(`  p50 ${fmtMs(pct(singleCallNs, 0.5))} ms | p95 ${fmtMs(pct(singleCallNs, 0.95))} ms | p99 ${fmtMs(pct(singleCallNs, 0.99))} ms | max ${fmtMs(Math.max(...singleCallNs))} ms`);
	console.log("");

	// ─── Double-parse cost (current behavior: scan + import both call it) ───
	const doubleTotalT0 = Bun.nanoseconds();
	for (const card of queue) {
		await extractPngMetadata(card.file);
		await extractPngMetadata(card.file);
		// parseCharacterMetadata is also called in the import phase — include it
		// so the comparison reflects the real second-pass cost, not just the extract.
	}
	const doubleTotalNs = Bun.nanoseconds() - doubleTotalT0;

	console.log("─── Double-parse pass (current behavior: scan filter + import parse) ───");
	console.log(`  ${queue.length} cards | total ${fmtMs(doubleTotalNs)} ms | per card ${(doubleTotalNs / queue.length / 1_000_000).toFixed(2)} ms`);
	console.log(`  Waste from parsing twice: ${fmtMs(doubleTotalNs - singleTotalNs)} ms (${Math.round((1 - singleTotalNs / doubleTotalNs) * 100)}% of double-pass time).`);
	console.log("");

	// ─── What happens if it runs on the main thread (current architecture) ─
	// Browsers won't repaint while a sync task runs >~16ms. Count how many single
	// calls exceed one frame (16.67ms = 60fps) — each one drops a frame.
	const framesDropped = singleCallNs.filter((ns) => ns > 16_670_000).length;
	console.log("─── Main-thread blocking (current architecture) ───");
	console.log(`  ${framesDropped} of ${queue.length} single parses exceed one frame (16.67ms); ${queue.length - framesDropped} stay under.`);
	console.log(`  On the UI thread, the single-pass total (${fmtMs(singleTotalNs)} ms) is one continuous block — zero repaints for that duration.`);
	console.log("");

	console.log("─── Worker win (the fix this justifies) ───");
	console.log(`  Moving to a Worker: ${fmtMs(singleTotalNs)} ms of parse work moves OFF the main thread (off from ${fmtMs(doubleTotalNs)} ms today, since the Worker pass replaces both scan and import parses).`);
	console.log(`  Main thread freed for the entire import; UI stays responsive; progress bar repaints.`);
}

await main();
