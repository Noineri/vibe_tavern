import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/index.js";

describe("isRecord", () => {
  test("plain object → true", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: "value" })).toBe(true);
  });

  test("array → false", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ key: "value" }])).toBe(false);
  });

  test("null → false", () => {
    expect(isRecord(null)).toBe(false);
  });

  test("string → false", () => {
    expect(isRecord("object")).toBe(false);
    expect(isRecord("")).toBe(false);
  });

  test("number → false", () => {
    expect(isRecord(0)).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  test("undefined → false", () => {
    expect(isRecord(undefined)).toBe(false);
  });
});
