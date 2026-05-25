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

/**
 * Embed character card JSON into a PNG buffer.
 * Inserts "chara" (v2) + "ccv3" (v3) tEXt chunks before IEND.
 * Removes existing chara/ccv3 chunks first.
 */
export function embedCharaMetadata(pngBytes: Uint8Array, json: string): Uint8Array {
  const chunks = extractChunks(pngBytes);
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].name !== "tEXt") continue;
    if (["chara", "ccv3"].includes(decodeText(chunks[i].data).keyword.toLowerCase())) {
      chunks.splice(i, 1);
    }
  }
  // ccv3 first (v3 spec), then chara (v2 compat)
  try {
    const v3 = JSON.parse(json);
    v3.spec = "chara_card_v3"; v3.spec_version = "3.0";
    chunks.splice(-1, 0, { name: "tEXt", data: encodeText("ccv3", utf8ToBase64(JSON.stringify(v3))) });
  } catch { /* skip ccv3 */ }
  chunks.splice(-1, 0, { name: "tEXt", data: encodeText("chara", utf8ToBase64(json)) });
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
