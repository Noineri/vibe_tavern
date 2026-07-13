import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { parseStructuredOutput } from "../src/domain/insights/structured-output.js";

const verdictSchema = z.object({ completed: z.boolean() }).strict();

describe("parseStructuredOutput", () => {
  it("parses an exact JSON object", () => {
    expect(parseStructuredOutput('{"completed":false}', verdictSchema)).toEqual({ completed: false });
  });

  it("extracts JSON from a markdown fence or surrounding prose", () => {
    expect(parseStructuredOutput('```json\n{"completed":true}\n```', verdictSchema)).toEqual({ completed: true });
    expect(parseStructuredOutput('Result: {"completed":false} done.', verdictSchema)).toEqual({ completed: false });
  });

  it("handles braces inside JSON strings while finding the balanced object", () => {
    const schema = z.object({ text: z.string() }).strict();
    expect(parseStructuredOutput('prefix {"text":"keep {this} intact"} suffix', schema)).toEqual({ text: "keep {this} intact" });
  });

  it("rejects malformed JSON and schema-invalid values with a useful error", () => {
    expect(() => parseStructuredOutput('{"completed":', verdictSchema)).toThrow("valid JSON object");
    expect(() => parseStructuredOutput('{"completed":"yes"}', verdictSchema)).toThrow("completed");
    expect(() => parseStructuredOutput('{"completed":true,"extra":1}', verdictSchema)).toThrow("extra");
  });
});
