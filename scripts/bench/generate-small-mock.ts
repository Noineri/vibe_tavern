// Small ST-shaped mock folder for visual progress-bar smoke tests.
// 40 characters, 2 chats each (5 msgs), 3 lorebooks, 2 presets, 1 persona.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_OUT = join(tmpdir(), "vt-mock-small");
const args = process.argv.slice(2);
const { tokens } = parseArgs({
	args,
	options: {},
	strict: false,
	allowPositionals: true,
	tokens: true,
});
const firstArgIndex = tokens[0]?.index;
const OUT = firstArgIndex === undefined ? DEFAULT_OUT : (args[firstArgIndex] ?? DEFAULT_OUT);
const N = 300;

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

async function main() {
	await mkdir(join(OUT, "characters"), { recursive: true });
	await mkdir(join(OUT, "chats"), { recursive: true });
	await mkdir(join(OUT, "worlds"), { recursive: true });
	await mkdir(join(OUT, "OpenAI Settings"), { recursive: true });

	for (let i = 1; i <= N; i++) {
		const card = { spec: "chara_card_v3", spec_version: "3.0", data: { name: `Mock ${i}`, description: "d", first_mes: "Hello there." } };
		// PNG with embedded chara JSON so the scanner's avatar write fires too.
		const meta = Buffer.from(JSON.stringify(card)).toString("base64");
		// Minimal PNG with a tEXt chunk carrying chara — reuse the bench embedder if present,
		// else just write a JSON card (avatar-less is fine for a layout check).
		await Bun.write(join(OUT, "characters", `Mock${i}.json`), JSON.stringify(card));

		const chatDir = join(OUT, "chats", `mock ${i}`);
		await mkdir(chatDir, { recursive: true });
		const lines = [];
		for (let m = 0; m < 5; m++) {
			lines.push(JSON.stringify({ name: m % 2 === 0 ? "Mock " + i : "User", is_user: m % 2 === 1, is_system: false, send_date: "1/1/2026", mes: m % 2 === 0 ? `Message ${m} from Mock ${i}.` : `Reply ${m}.` }));
		}
		await Bun.write(join(chatDir, `chat-${i}.jsonl`), lines.join("\n"));
	}

	for (let i = 0; i < 3; i++) {
		await Bun.write(join(OUT, "worlds", `World${i}.json`), JSON.stringify({ name: `World ${i}`, entries: { "0": { uid: 0, key: ["x"], keysecondary: [], content: "entry", comment: "", constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, delayRecursion: false, probability: 100, useProbability: true, depth: 4, group: "", groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: "", role: null, sticky: null, cooldown: null, delay: null, displayIndex: i } } }));
	}

	for (let i = 0; i < 2; i++) {
		await Bun.write(join(OUT, "OpenAI Settings", `Preset${i}.json`), JSON.stringify({ chat_start: "", prompts: [{ identifier: "main", name: "main", content: "You are a roleplay assistant.", role: "system" }], prompt_order: { dummy: { order: [{ identifier: "main" }] } }, temperature: 0.8 }));
	}

	await Bun.write(join(OUT, "settings.json"), JSON.stringify({ persona_descriptions: { "default.png": { description: "A smoke-test persona." } }, default_persona: "default.png" }));

	console.log(`Small mock generated at ${OUT} (${N} chars, ${N * 2} chats... wait, 1 chat each here)`);
}
void main();
