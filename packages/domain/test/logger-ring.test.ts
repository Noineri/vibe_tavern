import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tag, recentLogLines, _resetLogRingForTests } from "../src/logger.js";

// L1: pure in-memory capture, no paths/DBs/timers; the ring is reset before
// and after the file so sibling domain files see an empty buffer.

beforeAll(() => _resetLogRingForTests());
afterAll(() => _resetLogRingForTests());

describe("logger ring buffer", () => {
  test("captures tagged lines with level, timestamp and printf args", () => {
    _resetLogRingForTests();
    const logger = tag("ring-test");
    logger.info("loaded %d entries for %s", 3, "cards");
    logger.warn("odd value: %j", { odd: true });
    const lines = [...recentLogLines()];
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO\[ring-test\] loaded 3 entries for cards$/);
    expect(lines[1]).toMatch(/WARN\[ring-test\] odd value: \{"odd":true\}$/);
  });

  test("errors are always captured, even with an Error argument", () => {
    _resetLogRingForTests();
    tag("ring-err").error("failed:", new Error("boom"));
    const line = recentLogLines()[0]!;
    expect(line).toContain("ERROR[ring-err] failed:");
    expect(line).toContain("Error: boom");
  });

  test("debug stays hidden at the default level — the console gate applies", () => {
    _resetLogRingForTests();
    tag("ring-quiet").debug("should not be captured %s", "here");
    expect(recentLogLines().length).toBe(0);
  });

  test("the ring keeps only the last RING_CAPACITY lines", () => {
    _resetLogRingForTests();
    const logger = tag("ring-flood");
    for (let i = 0; i < 600; i++) logger.info("line %d", i);
    const lines = [...recentLogLines()];
    expect(lines.length).toBe(500);
    expect(lines[0]).toContain("line 100");
    expect(lines[499]).toContain("line 599");
  });

  test("child loggers carry the composed tag into the buffer", () => {
    _resetLogRingForTests();
    tag("parent").child("child").warn("nested");
    expect(recentLogLines()[0]).toContain("WARN[parent:child] nested");
  });
});
