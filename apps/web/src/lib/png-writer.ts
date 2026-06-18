/**
 * PNG chunk writer — embeds character card metadata into PNG files.
 *
 * Character Card V3 spec: inserts `tEXt` chunks with keywords "chara" (v2) and
 * "ccv3" (v3) containing base64-encoded card JSON. Chunks go before IEND.
 *
 * Based on SillyTavern's character-card-parser.js approach:
 *   decode chunks → remove old chara/ccv3 → insert new → re-encode
 */

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function crc32(data: Uint8Array, startCrc = 0): number {
  let c = (startCrc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface PngChunk { name: string; data: Uint8Array }

function isPNG(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function extractChunks(png: Uint8Array): PngChunk[] {
  if (!isPNG(png)) throw new Error("Not a valid PNG file");
  const chunks: PngChunk[] = [];
  let offset = 8;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (offset + 8 <= png.length) {
    const len = view.getUint32(offset, false);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    chunks.push({ name: type, data: png.subarray(offset + 8, offset + 8 + len) });
    offset += 12 + len;
  }
  return chunks;
}

function encodeChunks(chunks: PngChunk[]): Uint8Array {
  let totalSize = 8;
  for (const c of chunks) totalSize += 12 + c.data.length;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out.set(PNG_SIG, 0);
  let pos = 8;
  for (const c of chunks) {
    view.setUint32(pos, c.data.length, false); pos += 4;
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) { out[pos] = c.name.charCodeAt(i); typeBytes[i] = out[pos]; pos++; }
    out.set(c.data, pos); pos += c.data.length;
    view.setUint32(pos, crc32(c.data, crc32(typeBytes)), false); pos += 4;
  }
  return out;
}

function decodeText(data: Uint8Array): { keyword: string; text: string } {
  const nul = data.indexOf(0);
  if (nul < 0) throw new Error("Invalid tEXt chunk");
  return {
    keyword: new TextDecoder().decode(data.subarray(0, nul)),
    text: new TextDecoder().decode(data.subarray(nul + 1)),
  };
}

function encodeText(keyword: string, text: string): Uint8Array {
  const kw = new TextEncoder().encode(keyword);
  const txt = new TextEncoder().encode(text);
  const out = new Uint8Array(kw.length + 1 + txt.length);
  out.set(kw, 0); out[kw.length] = 0; out.set(txt, kw.length + 1);
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** V2-era ("v1CharData") content fields SillyTavern keeps at the top level
 *  alongside the V3 `data` block, for backward compat with V2-only parsers.
 *  Strict V2 parsers (janitor.ai and similar) read `name` / `description` /
 *  `first_mes` etc. from the TOP level — without these duplicates the card
 *  reads as empty even though `data` is fully populated.
 *
 *  Each entry maps a V3 `data` key → the V2 top-level key name. Note the one
 *  rename: V3 `creator_notes` is exposed as V2 `creatorcomment`. Source of
 *  truth: the `v1CharData` typedef in SillyTavern/public/scripts/char-data.js.
 *
 *  CANONICAL COPY: packages/import-export/src/cards/chara-card-v3.ts exports
 *  the same mapping as `V2_TOPLEVEL_FIELDS` + a `flattenV2CompatFields`
 *  helper used by `exportCharacter` (JSON export). This self-contained copy
 *  exists only because apps/web cannot import that package (dep graph). Keep
 *  both in sync when editing. */
const V2_TOPLEVEL_FIELDS: ReadonlyArray<readonly [dataKey: string, v2Key: string]> = [
  ["name", "name"],
  ["description", "description"],
  ["personality", "personality"],
  ["scenario", "scenario"],
  ["first_mes", "first_mes"],
  ["mes_example", "mes_example"],
  ["tags", "tags"],
  ["creator_notes", "creatorcomment"],
];

/**
 * Embed character card JSON into a PNG buffer as SillyTavern-compatible
 * `chara` (v2) + `ccv3` (v3) tEXt chunks before IEND. Removes existing
 * chara/ccv3 chunks first.
 *
 * The written payload mirrors what SillyTavern itself produces on export: the
 * canonical V3 structure stays under `data`, and the V2-era fields are
 * duplicated at the top level (plus ST-stamped metadata: `create_date`,
 * `fav`, `creatorcomment`, `avatar`, `talkativeness`). The SAME base64 payload
 * goes into both chunks. This dual shape is what lets strict V2 parsers find
 * the character data where they expect it; emitting only `{spec, spec_version,
 * data}` makes such parsers see an empty card.
 */
export function embedCharaMetadata(pngBytes: Uint8Array, json: string): Uint8Array {
  const chunks = extractChunks(pngBytes);
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].name !== "tEXt") continue;
    if (["chara", "ccv3"].includes(decodeText(chunks[i].data).keyword.toLowerCase())) {
      chunks.splice(i, 1);
    }
  }

  const card = JSON.parse(json) as Record<string, unknown>;
  card.spec = "chara_card_v3";
  card.spec_version = "3.0";

  // Flatten the full v1CharData field set to the top level (mirrors ST's
  // export shape). `data` stays canonical; the top-level copies are the V2
  // compat surface. We always overwrite from `data` so the two never drift —
  // the V3 block under `data` is the source of truth.
  const data = card.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    for (const [dataKey, v2Key] of V2_TOPLEVEL_FIELDS) {
      if (dataKey in d) card[v2Key] = d[dataKey];
    }
  }

  // ST stamps these v1CharData meta fields at the top level on every export.
  // Only set when absent so a re-embed of an already-ST-shaped card is stable.
  // `talkativeness` also lives under data.extensions in ST; prefer that if present.
  const ext = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).extensions
    : undefined;
  const extTalkativeness = ext && typeof ext === "object" && !Array.isArray(ext)
    ? (ext as Record<string, unknown>).talkativeness
    : undefined;
  if (card.create_date == null) card.create_date = new Date().toISOString();
  if (card.fav == null) card.fav = false;
  if (card.creatorcomment == null) card.creatorcomment = "";
  if (card.avatar == null) card.avatar = "none";
  if (card.talkativeness == null) card.talkativeness = extTalkativeness ?? "0.5";

  const payload = utf8ToBase64(JSON.stringify(card));
  // ST writes `chara` first, then `ccv3`, both carrying the identical payload.
  chunks.splice(-1, 0, { name: "tEXt", data: encodeText("chara", payload) });
  chunks.splice(-1, 0, { name: "tEXt", data: encodeText("ccv3", payload) });
  return encodeChunks(chunks);
}

/**
 * Convert any image to PNG with embedded character card metadata.
 * If already PNG → embed directly (preserves quality).
 * If JPEG/WebP/GIF → convert via Canvas first.
 */
export async function exportCharaCardPng(imageBytes: Uint8Array, json: string): Promise<Uint8Array> {
  if (isPNG(imageBytes)) {
    return embedCharaMetadata(imageBytes, json);
  }
  // Non-PNG: convert via Canvas
  const blob = new Blob([imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength) as ArrayBuffer]);
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const pngBlob = await new Promise<Blob>((res, rej) => {
      canvas.toBlob((b) => b ? res(b) : rej(new Error("Canvas toBlob failed")), "image/png");
    });
    return embedCharaMetadata(new Uint8Array(await pngBlob.arrayBuffer()), json);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Failed to load image"));
    img.src = url;
  });
}
