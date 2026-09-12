import { describe, expect, it } from "bun:test";

import {
	KOKORO_HF_BASE,
	KOKORO_MIRROR_PATH,
	rewriteHfUrl,
} from "./kokoro-mirror.js";

describe("kokoro-mirror rewriteHfUrl", () => {
	it("rewrites model files from the fixed Kokoro repo", () => {
		expect(rewriteHfUrl(`${KOKORO_HF_BASE}onnx/model_q4f16.onnx`)).toBe(
			`${KOKORO_MIRROR_PATH}onnx/model_q4f16.onnx`,
		);
		expect(rewriteHfUrl(`${KOKORO_HF_BASE}config.json`)).toBe(
			`${KOKORO_MIRROR_PATH}config.json`,
		);
	});

	it("rewrites the voice blobs kokoro-js dist fetches directly", () => {
		expect(rewriteHfUrl(`${KOKORO_HF_BASE}voices/af_heart.bin`)).toBe(
			`${KOKORO_MIRROR_PATH}voices/af_heart.bin`,
		);
	});

	it("preserves query strings", () => {
		expect(rewriteHfUrl(`${KOKORO_HF_BASE}tokenizer.json?download=true`)).toBe(
			`${KOKORO_MIRROR_PATH}tokenizer.json?download=true`,
		);
	});

	it("leaves other HF repos untouched", () => {
		expect(
			rewriteHfUrl("https://huggingface.co/other-org/other-repo/resolve/main/model.onnx"),
		).toBeNull();
		expect(rewriteHfUrl("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/dev/config.json")).toBeNull();
	});

	it("leaves non-HF URLs untouched", () => {
		expect(rewriteHfUrl("https://cdn.jsdelivr.net/npm/onnxruntime/dist/ort-wasm.wasm")).toBeNull();
		expect(rewriteHfUrl("/api/tts/kokoro/model/config.json")).toBeNull();
	});

	it("rejects the bare base with no file path", () => {
		expect(rewriteHfUrl(KOKORO_HF_BASE)).toBeNull();
	});

	it("only rewrites http/https huggingface.co origins (scheme-relative look-alikes rejected)", () => {
		// A //huggingface.co/... string does not start with the https base —
		// the startsWith guard is the whole contract here.
		expect(rewriteHfUrl("//huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json")).toBeNull();
	});
});
