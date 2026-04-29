import { describe, it, expect } from "bun:test";
import { replaceMacros } from "../dist/macros.js";

describe("replaceMacros", () => {
  const ctx = {
    charName: "Aria",
    userName: "Olya",
  };

  it("resolves {{char}}", () => {
    expect(
      replaceMacros("I am {{char}}.", ctx),
    ).toBe("I am Aria.");
  });

  it("resolves {{user}}", () => {
    expect(
      replaceMacros("Hello {{user}}.", ctx),
    ).toBe("Hello Olya.");
  });

  it("does NOT resolve {{persona}} (not in MacroContext)", () => {
    expect(
      replaceMacros("You are {{persona}}", ctx),
    ).toBe("You are {{persona}}");
  });

  it("resolves <BOT> and <USER>", () => {
    expect(
      replaceMacros("<BOT> speaks to <USER>.", ctx),
    ).toBe("Aria speaks to Olya.");
  });

  it("resolves {{original}} when provided", () => {
    expect(
      replaceMacros("{{original}} was renamed.", { ...ctx, originalName: "OldName" }),
    ).toBe("OldName was renamed.");
  });

  it("leaves {{original}} unresolved when originalName not provided", () => {
    expect(
      replaceMacros("{{original}} was renamed.", ctx),
    ).toBe("{{original}} was renamed.");
  });

  it("handles whitespace inside braces", () => {
    expect(
      replaceMacros("{{ char }} meets {{ user }}", ctx),
    ).toBe("Aria meets Olya");
  });

  it("is case-insensitive for macro names", () => {
    expect(
      replaceMacros("{{CHAR}} and {{User}}", ctx),
    ).toBe("Aria and Olya");
  });

  it("resolves multiple macros in one string", () => {
    const result = replaceMacros(
      "{{char}} greets {{user}}.",
      ctx,
    );
    expect(result).toBe("Aria greets Olya.");
    expect(result).not.toContain("{{");
  });

  it("returns input unchanged when no macros present", () => {
    expect(
      replaceMacros("Just plain text.", ctx),
    ).toBe("Just plain text.");
  });

  it("returns input for empty/falsy values", () => {
    expect(replaceMacros("", ctx)).toBe("");
    // @ts-expect-error testing null input
    expect(replaceMacros(null, ctx)).toBe(null);
  });
});
