import { describe, expect, it } from "bun:test";
import { WHISPER_LANGUAGES, whisperLanguageForLocale, whisperLanguageLabel } from "./whisper-languages.js";

describe("whisper-languages catalog (P12)", () => {
  it("carries the full whisper catalog (codes are 2-3 lowercase letters, unique)", () => {
    expect(WHISPER_LANGUAGES.length).toBeGreaterThan(90);
    const codes = WHISPER_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const language of WHISPER_LANGUAGES) {
      expect(language.code).toMatch(/^[a-z]{2,3}$/);
      expect(language.name.length).toBeGreaterThan(0);
    }
    expect(codes).toContain("ru");
    expect(codes).toContain("en");
  });

  it("is sorted alphabetically by English name", () => {
    const names = WHISPER_LANGUAGES.map((l) => l.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("resolves interface locales to whisper codes (region suffix tolerated)", () => {
    expect(whisperLanguageForLocale("ru")).toBe("ru");
    expect(whisperLanguageForLocale("en")).toBe("en");
    expect(whisperLanguageForLocale("ru-RU")).toBe("ru");
    expect(whisperLanguageForLocale("EN")).toBe("en");
  });

  it("resolves unknown locales to undefined (never a guess — invalid hints throw)", () => {
    expect(whisperLanguageForLocale("xx")).toBeUndefined();
    expect(whisperLanguageForLocale("")).toBeUndefined();
  });

  it("labels read as human names with the code", () => {
    const russian = WHISPER_LANGUAGES.find((l) => l.code === "ru");
    expect(russian).toBeTruthy();
    expect(whisperLanguageLabel(russian!)).toBe("Russian (ru)");
  });
});
