import { describe, test, expect } from "bun:test";
import {
  deflateTraceValue,
  inflateTraceValue,
  collectTraceChunkIds,
  hashTraceChunk,
  TRACE_CHUNK_MARKER,
  TRACE_CHUNK_THRESHOLD,
} from "../src/trace-chunking.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const bigText = (seed: string, chars: number): string => {
  const unit = `${seed}-абв gdzie ēеё`;
  let out = "";
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
};

const roundtrip = (value: unknown): { deflated: ReturnType<typeof deflateTraceValue>; inflated: unknown } => {
  const deflated = deflateTraceValue(value);
  const map = new Map(deflated.chunks.map((c) => [c.id, c.content]));
  const inflated = inflateTraceValue(deflated.skeleton, (id) => map.get(id));
  return { deflated, inflated };
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("trace-chunking", () => {
  test("roundtrip is deep-equal and re-stringifies byte-identically", () => {
    const value = {
      layers: [
        { sourceType: "system", text: bigText("sys", 8000), tokenCount: 2000 },
        { sourceType: "history", text: bigText("msg-1", 3000), tokenCount: 800 },
      ],
      messages: [
        { role: "user", content: "короткое сообщение" },
        { role: "assistant", content: bigText("reply", 5000) },
      ],
      numbers: { a: 1, b: 0.5, c: null, d: true },
    };
    const { deflated, inflated } = roundtrip(value);
    expect(inflated).toEqual(value);
    // The inflated value must serialize exactly like the original document —
    // consumers (export DTO, ST mirror writeJson) receive parsed objects, but
    // byte-identity is the stronger guarantee the design promises.
    expect(JSON.stringify(inflated)).toBe(JSON.stringify(value));
    // Both big strings moved to chunks; small ones stayed inline.
    expect(deflated.chunks.length).toBe(3);
  });

  test("threshold boundary: 255 stays inline, 256 is chunked", () => {
    const value = { a: bigText("x", TRACE_CHUNK_THRESHOLD - 1), b: bigText("y", TRACE_CHUNK_THRESHOLD) };
    const { deflated, inflated } = roundtrip(value);
    expect(deflated.chunks.length).toBe(1);
    expect(deflated.chunks[0]!.content).toBe(value.b);
    expect(deflated.skeleton).toEqual({ a: value.a, b: { [TRACE_CHUNK_MARKER]: hashTraceChunk(value.b) } });
    expect(inflated).toEqual(value);
  });

  test("identical strings dedup to one chunk", () => {
    const shared = bigText("shared-history", 10_000);
    const { skeleton, chunks } = deflateTraceValue({ first: shared, nested: { second: shared }, list: [shared] });
    expect(chunks.length).toBe(1);
    expect(collectTraceChunkIds(skeleton)).toEqual([chunks[0]!.id, chunks[0]!.id, chunks[0]!.id]);
  });

  test("user string that looks like a marker object does not collide", () => {
    // A user message whose TEXT is the JSON of a marker — it is a string, so
    // it is chunked as a whole; inflation only substitutes marker OBJECTS.
    const decoy = `{"${TRACE_CHUNK_MARKER}":"${"a".repeat(64)}"}`;
    const value = { content: decoy };
    const { inflated } = roundtrip(value);
    expect(inflated).toEqual(value);
  });

  test("inflation throws on a missing chunk instead of leaking a marker", () => {
    const { skeleton } = deflateTraceValue({ content: bigText("gone", 5000) });
    expect(() => inflateTraceValue(skeleton, () => undefined)).toThrow(/missing from prompt_trace_chunks/);
  });

  test("chunk id is sha256 of the utf-8 content", () => {
    const content = bigText("hash-me", 600);
    const { chunks } = deflateTraceValue({ content });
    expect(chunks[0]!.id).toBe(hashTraceChunk(content));
    expect(chunks[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty and null-ish documents pass through untouched", () => {
    expect(deflateTraceValue({}).chunks).toEqual([]);
    expect(deflateTraceValue({ messages: [] }).skeleton).toEqual({ messages: [] });
    const { inflated } = roundtrip(null);
    expect(inflated).toBe(null);
  });
});
