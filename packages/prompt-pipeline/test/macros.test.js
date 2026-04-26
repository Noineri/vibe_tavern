import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { replaceMacros } from "../dist/macros.js";

describe("replaceMacros", () => {
  const ctx = {
    charName: "Aria",
    userName: "Olya",
  };

  it("resolves {{char}}", () => {
    assert.strictEqual(
      replaceMacros("I am {{char}}.", ctx),
      "I am Aria.",
    );
  });

  it("resolves {{user}}", () => {
    assert.strictEqual(
      replaceMacros("Hello {{user}}.", ctx),
      "Hello Olya.",
    );
  });

  it("does NOT resolve {{persona}} (not in MacroContext)", () => {
    assert.strictEqual(
      replaceMacros("You are {{persona}}", ctx),
      "You are {{persona}}",
    );
  });

  it("resolves <BOT> and <USER>", () => {
    assert.strictEqual(
      replaceMacros("<BOT> speaks to <USER>.", ctx),
      "Aria speaks to Olya.",
    );
  });

  it("resolves {{original}} when provided", () => {
    assert.strictEqual(
      replaceMacros("{{original}} was renamed.", { ...ctx, originalName: "OldName" }),
      "OldName was renamed.",
    );
  });

  it("leaves {{original}} unresolved when originalName not provided", () => {
    assert.strictEqual(
      replaceMacros("{{original}} was renamed.", ctx),
      "{{original}} was renamed.",
    );
  });

  it("handles whitespace inside braces", () => {
    assert.strictEqual(
      replaceMacros("{{ char }} meets {{ user }}", ctx),
      "Aria meets Olya",
    );
  });

  it("is case-insensitive for macro names", () => {
    assert.strictEqual(
      replaceMacros("{{CHAR}} and {{User}}", ctx),
      "Aria and Olya",
    );
  });

  it("resolves multiple macros in one string", () => {
    const result = replaceMacros(
      "{{char}} greets {{user}}.",
      ctx,
    );
    assert.strictEqual(result, "Aria greets Olya.");
    assert.ok(!result.includes("{{"));
  });

  it("returns input unchanged when no macros present", () => {
    assert.strictEqual(
      replaceMacros("Just plain text.", ctx),
      "Just plain text.",
    );
  });

  it("returns input for empty/falsy values", () => {
    assert.strictEqual(replaceMacros("", ctx), "");
    // @ts-expect-error testing null input
    assert.strictEqual(replaceMacros(null, ctx), null);
  });
});
