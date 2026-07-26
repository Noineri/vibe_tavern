/**
 * Characterization tests for `embedCharaMetadata` / `exportCharaCardPng`.
 *
 * Context: Vibe Tavern used to emit only the bare V3 shape
 * `{ spec, spec_version, data }` into PNG `chara`/`ccv3` chunks. Strict V2
 * parsers (janitor.ai and similar) read `name` / `description` / `first_mes`
 * from the TOP level of the card, so a bare-V3 card read as empty and was
 * rejected. SillyTavern instead writes a hybrid: the full V3 block under
 * `data` PLUS the V2-era ("v1CharData") field set duplicated at the top level,
 * with the SAME base64 payload in both chunks. These tests pin that hybrid
 * shape so the regression can't silently return.
 *
 * The expected field set is the one observed in a SillyTavern re-export and
 * documented by the `v1CharData` typedef in
 * SillyTavern/public/scripts/char-data.js.
 */
import { test, expect } from "bun:test";
import {
  embedCharaMetadata,
  // exportCharaCardPng,  // canvas-dependent; covered indirectly via embed
} from "./png-writer.js";
import { packMonolith, type VtfCharacterContent } from "@vibe-tavern/db/codecs";

// ── Minimal 1×1 PNG (IHDR + one IDAT + IEND). CRCs precomputed and valid. ──
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: number[]): Uint8Array {
  const typeBytes = [...name].map((c) => c.charCodeAt(0));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length, false);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body), false);
  return new Uint8Array([...len, ...body, ...crc]);
}
function minimalPng(): Uint8Array {
  // IHDR: 1×1, 8-bit, color type 2 (RGB)
  const ihdr = [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0];
  // IDAT: zlib-compressed (one zero-filter row + 3 zero bytes). Solid deflate
  // stream for that input (verified by the writer/reader accepting it).
  const idat = [
    0x78, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x80, 0x90, 0xfe, 0xaf, 0xee, 0x06, 0x00,
    0x01, 0x00, 0x01,
  ];
  const out = [
    ...PNG_SIG,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", []),
  ];
  return new Uint8Array(out);
}

// Bare V3 payload — what `exportCharacter` returns today.
const bareV3 = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Kieran Sullivan",
    description: "A quiet, overprotective roommate.",
    personality: "attentive",
    scenario: "sharing an apartment",
    first_mes: "The apartment was almost painfully quiet.",
    mes_example: "<START>\n{{char}}: hi\n<END>",
    creator_notes: "Original character.",
    system_prompt: "",
    post_history_instructions: "",
    depth_prompt: "",
    depth_prompt_depth: 4,
    depth_prompt_role: "system",
    alternate_greetings: [],
    extensions: {},
    tags: ["romance", "yandere"],
  },
};

/** Read every tEXt chunk back as { keyword, text } from the re-encoded PNG. */
function readTextChunks(png: Uint8Array): { keyword: string; text: string }[] {
  const out: { keyword: string; text: string }[] = [];
  let o = 8;
  while (o + 12 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(o, false);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    o += 12 + len;
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      out.push({
        keyword: new TextDecoder().decode(data.subarray(0, nul)),
        text: new TextDecoder().decode(data.subarray(nul + 1)),
      });
    }
    if (type === "IEND") break;
  }
  return out;
}

function decodeB64Json(text: string): Record<string, unknown> {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

test("embedCharaMetadata writes both `chara` and `ccv3` tEXt chunks", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const kws = readTextChunks(png).map((c) => c.keyword);
  expect(kws).toContain("chara");
  expect(kws).toContain("ccv3");
});

test("both chunks carry an identical base64 payload", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const chunks = readTextChunks(png);
  const chara = chunks.find((c) => c.keyword === "chara")!.text;
  const ccv3 = chunks.find((c) => c.keyword === "ccv3")!.text;
  expect(chara).toBe(ccv3);
});

test("V2-era fields are flattened to the top level (janitor.ai compat)", () => {
  // Regression: bare-V3 emission made strict V2 parsers see an empty card.
  // The top level must now carry the v1CharData field set, sourced from `data`.
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const card = decodeB64Json(readTextChunks(png).find((c) => c.keyword === "ccv3")!.text);

  expect(card.name).toBe("Kieran Sullivan");
  expect(card.description).toBe(bareV3.data.description);
  expect(card.personality).toBe("attentive");
  expect(card.scenario).toBe("sharing an apartment");
  expect(card.first_mes).toBe(bareV3.data.first_mes);
  expect(card.mes_example).toBe(bareV3.data.mes_example);
  expect(card.tags).toEqual(["romance", "yandere"]);
  // V3 `creator_notes` is renamed to V2 `creatorcomment` at the top level.
  expect(card.creatorcomment).toBe("Original character.");
  // `data` remains intact and canonical.
  expect((card.data as Record<string, unknown>).creator_notes).toBe("Original character.");
});

test("ST meta fields are stamped at the top level when absent", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const card = decodeB64Json(readTextChunks(png).find((c) => c.keyword === "ccv3")!.text);
  expect(card.fav).toBe(false);
  expect(card.avatar).toBe("none");
  expect(card.talkativeness).toBe("0.5");
  expect(typeof card.create_date).toBe("string");
  expect(card.create_date).not.toBe("");
});

test("data.extensions.talkativeness wins over the 0.5 default", () => {
  const withExt = JSON.parse(JSON.stringify(bareV3)) as typeof bareV3;
  withExt.data.extensions = { talkativeness: "0.9" };
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(withExt));
  const card = decodeB64Json(readTextChunks(png).find((c) => c.keyword === "ccv3")!.text);
  expect(card.talkativeness).toBe("0.9");
});

test("top-level V2 fields always mirror `data` (no drift on re-embed)", () => {
  // If a caller passes a card that already has stale top-level fields,
  // embed must overwrite them from the canonical `data` block.
  const hybrid = JSON.parse(JSON.stringify(bareV3)) as Record<string, unknown>;
  hybrid.name = "STALE NAME"; // stale top-level copy
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(hybrid));
  const card = decodeB64Json(readTextChunks(png).find((c) => c.keyword === "ccv3")!.text);
  expect(card.name).toBe("Kieran Sullivan"); // data wins
});

test("re-embedding replaces existing chara/ccv3 chunks (no duplication)", () => {
  const once = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const twice = embedCharaMetadata(once, JSON.stringify(bareV3));
  const kws = readTextChunks(twice).map((c) => c.keyword);
  expect(kws.filter((k) => k === "chara").length).toBe(1);
  expect(kws.filter((k) => k === "ccv3").length).toBe(1);
});

test("emitted PNG stays a valid PNG (signature + at least IEND)", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIG);
  // IEND chunk type appears somewhere.
  let hasIend = false;
  let o = 8;
  while (o + 8 <= png.length) {
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === "IEND") { hasIend = true; break; }
    const len = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(o, false);
    o += 12 + len;
  }
  expect(hasIend).toBe(true);
});

// ── VTF monolith `vtmd` chunk (VTF-14) ─────────────────────────────────────
// The vtmd chunk carries the canonical VTF monolith `.md` (base64) ALONGSIDE
// the ST-compatible chara/ccv3 chunks, so a PNG is readable by both VT
// (lossless native form) and ST. It is omitted when no VTF content is supplied.
const vtfContent: VtfCharacterContent = {
  name: "Test Character",
  description: "A test personality.",
  personalitySummary: null,
  defaultScenario: null,
  firstMessage: "Hello there.",
  mesExample: null,
  mesExampleMode: "always",
  mesExampleDepth: 4,
  alternateGreetings: [],
  postHistoryInstructions: null,
  creatorNotes: null,
  depthPrompt: null,
  depthPromptDepth: null,
  depthPromptRole: null,
  systemPrompt: null,
  tags: ["test"],
  extensions: {},
};

test("vtmd chunk is written alongside chara/ccv3 when vtfContent is supplied", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3), vtfContent);
  const kws = readTextChunks(png).map((c) => c.keyword);
  expect(kws).toContain("chara");
  expect(kws).toContain("ccv3");
  expect(kws).toContain("vtmd");
});

test("vtmd chunk is absent when vtfContent is omitted (plain ST-compatible PNG)", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3));
  const kws = readTextChunks(png).map((c) => c.keyword);
  expect(kws).not.toContain("vtmd");
});

test("vtmd chunk carries the canonical monolith (byte-identical to packMonolith)", () => {
  const png = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3), vtfContent);
  const vtmd = readTextChunks(png).find((c) => c.keyword === "vtmd")!.text;
  const md = Buffer.from(vtmd, "base64").toString("utf-8");
  expect(md).toBe(packMonolith(vtfContent));
  expect(md).toContain("# PERSONALITY");
  expect(md).toContain("A test personality.");
  expect(md).toContain("name: Test Character");
});

test("re-embedding replaces existing vtmd chunk (no duplication)", () => {
  const once = embedCharaMetadata(minimalPng(), JSON.stringify(bareV3), vtfContent);
  const twice = embedCharaMetadata(once, JSON.stringify(bareV3), vtfContent);
  const kws = readTextChunks(twice).map((c) => c.keyword);
  expect(kws.filter((k) => k === "vtmd").length).toBe(1);
  expect(kws.filter((k) => k === "chara").length).toBe(1);
  expect(kws.filter((k) => k === "ccv3").length).toBe(1);
});
