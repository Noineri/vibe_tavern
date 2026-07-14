/**
 * Scene Tracker prompt injection (SCENE_TRACKER_PLAN SCN-7).
 *
 * Two boundaries pinned here:
 *  1. The pure serialization helpers (formatSceneHistory / escapeXml) — JSON
 *     numbered list vs XML `<scene_history>` with escaped keys/values.
 *  2. The main-model `scene_state` layer emission — exactly ONE layer at
 *     priority 175, `in_chat`, depth from context, body wrapped via
 *     PROMPT_FORMAT.sceneState (with the optional injectPrompt lead); and NONE
 *     when `context.sceneState` is null/absent.
 *  3. The no-self-injection invariant: `assembleInsightsPrompt` (the Scene
 *     GENERATION path) strips BOTH `sceneState` and `objectiveTask` so the model
 *     judging a scene never sees scene noise or a duplicated task — while the
 *     main path (`assemblePrompt`) still injects it. Pure pipeline test: no DB,
 *     no LLM.
 */
import { describe, it, expect } from "bun:test";
import { assemblePrompt, assembleInsightsPrompt } from "../src/assemble.ts";
import { formatSceneHistory, escapeXml } from "../src/scene-injection.ts";

function baseContext(overrides = {}) {
	return {
		identity: { chatId: "chat_1" },
		chat: {
			recentMessages: [
				{ id: "msg_1", role: "user", content: "Hello." },
				{ id: "msg_2", role: "assistant", content: "Hi there." },
			],
		},
		character: {
			id: "char_1",
			name: "Aria",
			description: "A fire mage.",
			scenario: "The tower burns.",
			systemPrompt: null,
		},
		...overrides,
	};
}

const ENTRIES = [
	{ mood: "tense", tension: 7 },
	{ mood: "calm", tension: 3 },
];

describe("formatSceneHistory — serialization (SCN-7)", () => {
	it("json: numbered list, latest last", () => {
		const body = formatSceneHistory(ENTRIES, "json");
		expect(body).toBe('Scene history (latest last):\n1. {"mood":"tense","tension":7}\n2. {"mood":"calm","tension":3}');
	});

	it("xml: a scene_history block with one <scene> per entry", () => {
		const body = formatSceneHistory(ENTRIES, "xml");
		expect(body).toBe(
			"<scene_history>\n" +
			'<scene index="1">\n\t<mood>tense</mood>\n\t<tension>7</tension>\n</scene>\n' +
			'<scene index="2">\n\t<mood>calm</mood>\n\t<tension>3</tension>\n</scene>\n' +
			"</scene_history>",
		);
	});

	it("escapes XML special characters in keys and values (no tag breakout)", () => {
		const body = formatSceneHistory([{ "a<b>": "x&y\"z'w" }], "xml");
		expect(body).toBe(
			"<scene_history>\n" +
			'<scene index="1">\n\t<a&lt;b&gt;>x&amp;y&quot;z&apos;w</a&lt;b&gt;>\n</scene>\n' +
			"</scene_history>",
		);
	});

	it("empty history yields an empty string", () => {
		expect(formatSceneHistory([], "json")).toBe("");
		expect(formatSceneHistory([], "xml")).toBe("");
	});
});

describe("escapeXml", () => {
	it("escapes all five XML entities", () => {
		expect(escapeXml(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
	});
});

describe("assemblePrompt — scene_state layer (SCN-7)", () => {
	it("emits exactly ONE scene_state layer at priority 175, in_chat, with the configured depth", () => {
		const result = assemblePrompt(
			baseContext({
				sceneState: { entries: ENTRIES, format: "json", injectionDepth: 2, injectPrompt: "" },
			}),
		);
		const layers = result.layers.filter((l) => l.id === "scene_state");
		expect(layers).toHaveLength(1);
		expect(layers[0]!.sourceType).toBe("scene_state");
		expect(layers[0]!.position).toBe("in_chat");
		expect(layers[0]!.priority).toBe(175);
		expect(layers[0]!.injectionDepth).toBe(2);
	});

	it("wraps the body with the default [Scene state] label", () => {
		const result = assemblePrompt(
			baseContext({
				sceneState: { entries: ENTRIES, format: "json", injectionDepth: 1, injectPrompt: "" },
			}),
		);
		const layer = result.layers.find((l) => l.id === "scene_state");
		expect(layer!.text).toBe('[Scene state] Scene history (latest last):\n1. {"mood":"tense","tension":7}\n2. {"mood":"calm","tension":3}');
	});

	it("serializes XML when format is xml", () => {
		const result = assemblePrompt(
			baseContext({
				sceneState: { entries: [ENTRIES[0]!], format: "xml", injectionDepth: 1, injectPrompt: "" },
			}),
		);
		const layer = result.layers.find((l) => l.id === "scene_state");
		expect(layer!.text).toContain("<scene_history>");
		expect(layer!.text).toContain("<mood>tense</mood>");
	});

	it("prepends the custom injectPrompt lead when provided", () => {
		const result = assemblePrompt(
			baseContext({
				sceneState: { entries: ENTRIES, format: "json", injectionDepth: 1, injectPrompt: "Track the scene." },
			}),
		);
		const layer = result.layers.find((l) => l.id === "scene_state");
		expect(layer!.text).toBe(
			"Track the scene.\n[Scene state] Scene history (latest last):\n1. {\"mood\":\"tense\",\"tension\":7}\n2. {\"mood\":\"calm\",\"tension\":3}",
		);
	});

	it("emits NO scene_state layer when context.sceneState is null", () => {
		const result = assemblePrompt(baseContext({ sceneState: null }));
		expect(result.layers.find((l) => l.id === "scene_state")).toBeUndefined();
	});

	it("emits NO scene_state layer when context.sceneState is absent", () => {
		const result = assemblePrompt(baseContext());
		expect(result.layers.find((l) => l.id === "scene_state")).toBeUndefined();
	});
});

describe("assembleInsightsPrompt — no self-injection (SCN-7)", () => {
	it("strips scene_state AND objective_task from the Scene generation path", () => {
		// The Scene generation model must NOT see the sceneState it is judging, nor
		// a duplicated objectiveTask. assembleInsightsPrompt keeps the full RP
		// context but filters both self-injection layers.
		const result = assembleInsightsPrompt(
			baseContext({
				sceneState: { entries: ENTRIES, format: "json", injectionDepth: 1, injectPrompt: "" },
				objectiveTask: { description: "Reach the tower", injectPrompt: "", injectionDepth: 1 },
			}),
			"Generate the scene state for the latest reply.",
		);
		expect(result.layers.find((l) => l.id === "scene_state")).toBeUndefined();
		expect(result.layers.find((l) => l.id === "objective_task")).toBeUndefined();
		// The instruction itself IS present (the insights_instruction layer).
		expect(result.layers.find((l) => l.id === "insights_instruction")).toBeDefined();
	});

	it("the main path (assemblePrompt) still injects scene_state + objective_task", () => {
		const result = assemblePrompt(
			baseContext({
				sceneState: { entries: ENTRIES, format: "json", injectionDepth: 1, injectPrompt: "" },
				objectiveTask: { description: "Reach the tower", injectPrompt: "", injectionDepth: 1 },
			}),
		);
		expect(result.layers.find((l) => l.id === "scene_state")).toBeDefined();
		expect(result.layers.find((l) => l.id === "objective_task")).toBeDefined();
	});
});
