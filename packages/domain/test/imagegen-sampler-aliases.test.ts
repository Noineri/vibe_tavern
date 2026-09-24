import { describe, expect, test } from "bun:test";

import {
  adaptSamplerSetPayloadToTarget,
  resolveSamplerNameForDialect,
  resolveSchedulerNameForDialect,
  type SamplerLiveEntry,
} from "../src/index.js";

/** IF-7c: the cross-dialect vocabulary bridge — the stock rows carry names
 *  authored in one dialect (comfy ids for Krea/Anima, A1111 display names
 *  for Diffusion) and every set application resolves them against the
 *  TARGET's live list before the values ride the arm. */
describe("sampler dialect aliases", () => {
  const comfyList: SamplerLiveEntry[] = [
    { name: "euler" },
    { name: "euler_ancestral" },
    { name: "euler_sde" },
    { name: "dpmpp_2m" },
  ];
  const a1111List: SamplerLiveEntry[] = [
    { name: "Euler", aliases: ["euler"] },
    { name: "Euler a", aliases: ["euler_ancestral", "euler ancestral"] },
    { name: "Euler SDE", aliases: ["euler_sde"] },
  ];

  test("exact name match passes through unbridged", () => {
    expect(resolveSamplerNameForDialect("euler_sde", comfyList)).toEqual({
      name: "euler_sde",
      viaBridge: false,
    });
  });

  test("A1111's own aliases field bridges comfy ids to display names", () => {
    const res = resolveSamplerNameForDialect("euler_sde", a1111List);
    expect(res.name).toBe("Euler SDE");
    expect(res.viaBridge).toBe(true);
  });

  test("static map bridges A1111 display names to comfy combo ids (the Diffusion stock row case)", () => {
    expect(resolveSamplerNameForDialect("Euler a", comfyList).name).toBe("euler_ancestral");
  });

  test("static map bridges comfy ids to A1111 display names when the live list carries no aliases", () => {
    const bare: SamplerLiveEntry[] = [{ name: "Euler SDE" }, { name: "Euler" }];
    expect(resolveSamplerNameForDialect("euler_sde", bare).name).toBe("Euler SDE");
  });

  test("static map is case-insensitive on the stored name", () => {
    expect(resolveSamplerNameForDialect("euler a", comfyList).name).toBe("euler_ancestral");
  });

  test("karras-suffixed legacy names are deliberately NOT bridged — they encode a scheduler the map cannot express", () => {
    expect(resolveSamplerNameForDialect("DPM++ 2M Karras", comfyList).name).toBeNull();
  });

  test("a name absent from the live list and the map resolves to null (the honest hint case)", () => {
    expect(resolveSamplerNameForDialect("BogusSampler", comfyList).name).toBeNull();
  });

  test("empty live list applies the stored name unchanged — no list, no conclusion (options-data rule)", () => {
    expect(resolveSamplerNameForDialect("Euler a", [])).toEqual({
      name: "Euler a",
      viaBridge: false,
    });
  });

  test("schedulers are identity-vocabulary: exact match passes, absent is null, empty list passes through", () => {
    const schedulers: SamplerLiveEntry[] = [{ name: "simple" }, { name: "karras" }];
    expect(resolveSchedulerNameForDialect("simple", schedulers).name).toBe("simple");
    expect(resolveSchedulerNameForDialect("beta", schedulers).name).toBeNull();
    expect(resolveSchedulerNameForDialect("beta", []).name).toBe("beta");
  });
});

describe("adaptSamplerSetPayloadToTarget", () => {
  const comfyTarget = {
    dialect: "comfyui" as const,
    ditFamilyFixedVae: false,
    samplers: [
      { name: "euler" },
      { name: "euler_ancestral" },
      { name: "euler_sde" },
    ],
    schedulers: [{ name: "simple" }, { name: "karras" }],
    vaes: ["vae-ft-mse-840000.safetensors"],
  };

  test("the Diffusion stock row (A1111 vocabulary) translates for a comfy target and notes the bridge", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { sampler: "Euler a", scheduler: "karras", steps: 25, cfgScale: 5 },
      comfyTarget,
    );
    expect(payload.sampler).toBe("euler_ancestral");
    expect(payload.scheduler).toBe("karras");
    expect(payload.steps).toBe(25);
    expect(notes).toEqual([
      { field: "sampler", stored: "Euler a", resolved: "euler_ancestral", reason: "translated" },
    ]);
  });

  test("a missing sampler is skipped with a note — the arm keeps its current value, the rest applies", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { sampler: "BogusSampler", steps: 30 },
      comfyTarget,
    );
    expect(payload.sampler).toBeUndefined();
    expect(payload.steps).toBe(30);
    expect(notes).toEqual([
      { field: "sampler", stored: "BogusSampler", resolved: null, reason: "missing" },
    ]);
  });

  test("a missing scheduler is skipped with a note", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { scheduler: "beta" },
      comfyTarget,
    );
    expect(payload.scheduler).toBeUndefined();
    expect(notes[0]?.reason).toBe("missing");
    expect(notes[0]?.field).toBe("scheduler");
  });

  test("a set vae on a DiT target (family-fixed sidecar) is stripped + noted", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { sampler: "euler_sde", vae: "qwen_image_vae.safetensors" },
      { ...comfyTarget, ditFamilyFixedVae: true },
    );
    expect(payload.vae).toBeUndefined();
    expect(payload.sampler).toBe("euler_sde");
    expect(notes).toEqual([
      { field: "vae", stored: "qwen_image_vae.safetensors", resolved: null, reason: "dit-fixed-vae" },
    ]);
  });

  test("a vae outside the live list applies AS STORED with a note (stored-outside-list fallback)", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { vae: "not-in-list.safetensors" },
      comfyTarget,
    );
    expect(payload.vae).toBe("not-in-list.safetensors");
    expect(notes).toEqual([
      { field: "vae", stored: "not-in-list.safetensors", resolved: null, reason: "missing" },
    ]);
  });

  test("a listed vae applies silently", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { vae: "vae-ft-mse-840000.safetensors" },
      comfyTarget,
    );
    expect(payload.vae).toBe("vae-ft-mse-840000.safetensors");
    expect(notes).toEqual([]);
  });

  test("null dialect (no local sampler surface) applies the payload unchanged", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { sampler: "Euler a", scheduler: "simple" },
      { dialect: null, ditFamilyFixedVae: false, samplers: [], schedulers: [], vaes: [] },
    );
    expect(payload).toEqual({ sampler: "Euler a", scheduler: "simple" });
    expect(notes).toEqual([]);
  });

  test("empty live lists draw no conclusion — names apply as stored, no notes", () => {
    const { payload, notes } = adaptSamplerSetPayloadToTarget(
      { sampler: "Euler a", scheduler: "simple" },
      { dialect: "comfyui", ditFamilyFixedVae: false, samplers: [], schedulers: [], vaes: [] },
    );
    expect(payload.sampler).toBe("Euler a");
    expect(payload.scheduler).toBe("simple");
    expect(notes).toEqual([]);
  });
});
