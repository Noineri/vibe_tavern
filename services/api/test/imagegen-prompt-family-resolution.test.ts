import { describe, test, expect } from "bun:test";
import { resolveImageGenPromptFamily } from "../src/domain/imagegen/prompt-family-resolution.js";

// IPT-2_assembly — the pure generation-time family chain (T0):
// manual pin → fresh auto (the detection ran against the model ACTUALLY
// generating) → prose default. Pin/stale edges below are the ones the
// adapter's wiring rides.

describe("resolveImageGenPromptFamily (IPT-2)", () => {
  test("no state → prose default", () => {
    expect(resolveImageGenPromptFamily({}, undefined)).toEqual({ family: "prose", source: "default" });
    expect(resolveImageGenPromptFamily({}, "some-model")).toEqual({ family: "prose", source: "default" });
  });

  test("manual pin is authoritative — outranks any detection", () => {
    const res = resolveImageGenPromptFamily(
      { familyOverride: "pony", familyDetected: "qwen", familyDetectedForModel: "m1" },
      "m1",
    );
    expect(res).toEqual({ family: "pony", source: "manual" });
  });

  test("fresh auto: the detection ran against the effective model", () => {
    expect(
      resolveImageGenPromptFamily({ familyDetected: "noobai", familyDetectedForModel: "checkpoint-a.safetensors" }, "checkpoint-a.safetensors"),
    ).toEqual({ family: "noobai", source: "auto" });
  });

  test("stale auto: a model swap invalidates the detection → prose", () => {
    expect(
      resolveImageGenPromptFamily({ familyDetected: "pony", familyDetectedForModel: "old.safetensors" }, "new.safetensors"),
    ).toEqual({ family: "prose", source: "default" });
  });

  test("stale auto: no model generating at all (empty/undefined) cannot vouch for a detection", () => {
    expect(
      resolveImageGenPromptFamily({ familyDetected: "pony", familyDetectedForModel: "old.safetensors" }, undefined),
    ).toEqual({ family: "prose", source: "default" });
    expect(
      resolveImageGenPromptFamily({ familyDetected: "pony", familyDetectedForModel: "old.safetensors" }, ""),
    ).toEqual({ family: "prose", source: "default" });
  });

  test("detection without its model marker is never fresh (defensive read)", () => {
    expect(resolveImageGenPromptFamily({ familyDetected: "qwen" }, "m1")).toEqual({ family: "prose", source: "default" });
    expect(
      resolveImageGenPromptFamily({ familyDetected: "qwen", familyDetectedForModel: "" }, "m1"),
    ).toEqual({ family: "prose", source: "default" });
  });
});

describe("resolveImageGenPromptFamily — the backend-default tier (NAI-6a)", () => {
  test("no pin, no fresh detection → the backend default wins over prose", () => {
    expect(resolveImageGenPromptFamily({}, undefined, "novelai")).toEqual({ family: "novelai", source: "backend-default" });
    expect(resolveImageGenPromptFamily({}, "some-model", "novelai")).toEqual({ family: "novelai", source: "backend-default" });
  });

  test("the manual pin beats the backend default", () => {
    expect(
      resolveImageGenPromptFamily({ familyOverride: "pony" }, "m1", "novelai"),
    ).toEqual({ family: "pony", source: "manual" });
  });

  test("a fresh detection beats the backend default", () => {
    expect(
      resolveImageGenPromptFamily({ familyDetected: "qwen", familyDetectedForModel: "m1" }, "m1", "novelai"),
    ).toEqual({ family: "qwen", source: "auto" });
  });

  test("a stale detection falls to the backend default, not prose", () => {
    expect(
      resolveImageGenPromptFamily(
        { familyDetected: "pony", familyDetectedForModel: "old.safetensors" },
        "new.safetensors",
        "novelai",
      ),
    ).toEqual({ family: "novelai", source: "backend-default" });
  });

  test("no backend default → prose as before (every other backend unchanged)", () => {
    expect(resolveImageGenPromptFamily({}, "m1", undefined)).toEqual({ family: "prose", source: "default" });
    expect(
      resolveImageGenPromptFamily({ familyDetected: "pony", familyDetectedForModel: "old.safetensors" }, "new.safetensors"),
    ).toEqual({ family: "prose", source: "default" });
  });
});
