import { describe, expect, test } from "bun:test";
import { compileRussianCaseFormsKey, unwrapRussianCaseFormsKey } from "../src/russian-case-forms.js";

function matcher(key: string): RegExp {
  const parts = key.match(/^\/(.+)\/([a-z]*)$/s);
  if (!parts) throw new Error(`Expected an ST regex key, received ${key}`);
  return new RegExp(parts[1], parts[2]);
}

function matches(key: string, text: string): boolean {
  return matcher(compileRussianCaseFormsKey(key)).test(text);
}

describe("Russian case-forms compiler", () => {
  test("matches the approved prototype words and rejects boundary or stem false positives", () => {
    expect(matches("дракон", "дракона")) .toBe(true);
    expect(matches("Alisa", "ALISA")) .toBe(true);
    expect(matches("замок", "замком")) .toBe(true);
    expect(matches("отец", "отцом")) .toBe(true);
    expect(matches("кот", "кот")) .toBe(true);

    expect(matches("дракон", "мегадракон")) .toBe(false);
    expect(matches("кот", "который")) .toBe(false);
    expect(matches("кот", "скот")) .toBe(false);
    expect(matches("кот", "цель")) .toBe(false);
  });

  test("covers the approved declension-type ending sets", () => {
    expect(matches("дракон", "драконами")) .toBe(true);
    expect(matches("герой", "героями")) .toBe(true);
    expect(matches("ночь", "ночью")) .toBe(true);
    expect(matches("Алиса", "Алисой")) .toBe(true);
    expect(matches("неделя", "недель")) .toBe(true);
    expect(matches("чёрный", "чёрными")) .toBe(true);
    expect(matches("большой", "большого")) .toBe(true);
    expect(matches("ель", "ели")) .toBe(true);
    expect(matches("лев", "льва")) .toBe(true);
    expect(matches("лев", "левый")) .toBe(false);
    expect(matches("кот", "котовый")) .toBe(false);
  });

  test("handles fleeting vowels and normalizes ё to е", () => {
    expect(matches("замок", "замка")) .toBe(true);
    expect(matches("отец", "отца")) .toBe(true);
    expect(matches("чёрный", "черного")) .toBe(true);
  });

  test("marks only its own ST regex shape and restores the exact plain key", () => {
    expect(unwrapRussianCaseFormsKey(compileRussianCaseFormsKey("Чёрный замок"))).toBe("Чёрный замок");
    expect(unwrapRussianCaseFormsKey("/dragon/iu")).toBeNull();
  });
});
