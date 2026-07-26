import { test, expect } from "bun:test";
import { cleanAiCode } from "./ai-code-clean.js";

// Characterization tests — pin the behavior of the two byte-identical inline
// copies that were consolidated here (AI_ASSISTANT_GOD_OBJECT_AUDIT.md, finding 1).
// Run against the shared function to verify it is equivalent before the inline
// definitions are deleted.

test("passes through plain code with no fence, trimmed", () => {
  expect(cleanAiCode("console.log(1)")).toBe("console.log(1)");
  expect(cleanAiCode("  console.log(1)\n")).toBe("console.log(1)");
});

test("strips a ```js opening fence + closing fence", () => {
  expect(cleanAiCode("```js\nconsole.log(1)\n```")).toBe("console.log(1)");
});

test("strips a ```javascript opening fence + closing fence", () => {
  expect(cleanAiCode("```javascript\nconst x = 1;\n```")).toBe("const x = 1;");
});

test("strips a bare ``` opening fence + closing fence", () => {
  expect(cleanAiCode("```\ncode\n```")).toBe("code");
});

test("opening-fence language match is case-insensitive", () => {
  expect(cleanAiCode("```JS\nX\n```")).toBe("X");
  expect(cleanAiCode("```JavaScript\nY\n```")).toBe("Y");
});

test("strips fences even when surrounded by blank lines / whitespace", () => {
  expect(cleanAiCode("\n\n```js\nfoo()\n```\n\n")).toBe("foo()");
});

test("preserves inner newlines of multi-line code bodies", () => {
  expect(cleanAiCode("```js\nconst a = 1;\nconst b = 2;\n```")).toBe("const a = 1;\nconst b = 2;");
});

test("returns empty string for empty / whitespace-only input", () => {
  expect(cleanAiCode("")).toBe("");
  expect(cleanAiCode("   \n\t ")).toBe("");
});

test("only strips a fence anchored at start and end (mid-string fence survives)", () => {
  // Closing fence is not at the end here, so it is not stripped.
  expect(cleanAiCode("```\nx\n``` extra")).toBe("x\n``` extra");
});
