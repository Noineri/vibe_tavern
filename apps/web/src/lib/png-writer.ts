/**
 * PNG chunk writer — embeds character card metadata into PNG files.
 *
 * Character Card V3 spec: insert a `tEXt` chunk with keyword "chara"
 * containing the base64-encoded card JSON. The chunk goes right before IEND.
 *
 * PNG structure: Signature | IHDR | ... | tEXt (ours) | IEND
 * Each chunk: 4B length (big-endian) | 4B type | data | 4B CRC32
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function packChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const length = data.byteLength;
  const chunk = new Uint8Array(4 + 4 + length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, length, false); // big-endian length
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = crc32(new Uint8Array(chunk.buffer, 4, 4 + length));
  view.setUint32(8 + length, crc, false);
  return chunk;
}

/**
 * Embed character card JSON into a PNG buffer.
 *
 * @param pngBytes  Original PNG bytes (raw file buffer)
 * @param json      Character card JSON string to embed
 * @returns         New PNG buffer with tEXt chunk inserted before IEND
 */
export function embedCharaMetadata(pngBytes: Uint8Array, json: string): Uint8Array {
  // Validate PNG signature
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("Not a valid PNG file");
    }
  }

  // Build tEXt chunk: keyword "chara"\0 + base64 JSON
  const keyword = "chara";
  const b64 = toBase64(json);
  const textData = new TextEncoder().encode(keyword + "\0" + b64);
  const textChunk = packChunk("tEXt", textData);

  // Find IEND chunk — scan chunks from the start instead of assuming position
  // Each chunk: 4B len | 4B type | data | 4B CRC
  let pos = 8; // skip PNG signature
  while (pos + 8 <= pngBytes.length) {
    const clen = new DataView(pngBytes.buffer, pngBytes.byteOffset + pos, 4).getUint32(0, false);
    const ctype = new TextDecoder().decode(pngBytes.subarray(pos + 4, pos + 8));
    if (ctype === "IEND") {
      const iendStart = pos;
      // Build output: everything before IEND + our tEXt chunk + IEND
      const iendSize = 4 + 4 + clen + 4;
      const output = new Uint8Array(iendStart + textChunk.byteLength + iendSize);
      output.set(pngBytes.subarray(0, iendStart), 0);
      output.set(textChunk, iendStart);
      output.set(pngBytes.subarray(iendStart, iendStart + iendSize), iendStart + textChunk.byteLength);
      return output;
    }
    pos += 4 + 4 + clen + 4;
  }
  throw new Error("PNG missing IEND chunk");
}

/**
 * Create a minimal PNG with embedded character data (no avatar image).
 * Generates a 1×1 transparent pixel PNG with metadata.
 */
export function createMetadataPng(json: string): Uint8Array {
  // 1×1 RGBA transparent pixel — raw image data (filter byte + pixel)
  const filter = 0; // None filter
  const pixel = new Uint8Array([0, 0, 0, 0]); // transparent black
  const rawData = new Uint8Array(1 + 4);
  rawData[0] = filter;
  rawData.set(pixel, 1);

  // Deflate raw image data
  // Minimal deflate: 1-byte header | compressed data | adler32
  const deflated = deflateMinimal(rawData);

  const header = packChunk("IHDR", buildIhdr(1, 1));
  const idat = packChunk("IDAT", deflated);

  // Build keyword bytes
  const keyword = "chara";
  const b64 = toBase64(json);
  const textBytes = new TextEncoder().encode(keyword + "\0" + b64);
  const textChunk = packChunk("tEXt", textBytes);

  const iend = packChunk("IEND", new Uint8Array(0));

  // Assemble
  const totalSize = 8 + header.byteLength + idat.byteLength + textChunk.byteLength + iend.byteLength;
  const output = new Uint8Array(totalSize);
  let offset = 0;
  output.set(PNG_SIGNATURE, offset); offset += 8;
  output.set(header, offset); offset += header.byteLength;
  output.set(idat, offset); offset += idat.byteLength;
  output.set(textChunk, offset); offset += textChunk.byteLength;
  output.set(iend, offset);
  return output;
}

function buildIhdr(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(13);
  const view = new DataView(buf.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  view.setUint8(8, 8); // bit depth
  view.setUint8(9, 6); // color type: RGBA
  view.setUint8(10, 0); // compression
  view.setUint8(11, 0); // filter
  view.setUint8(12, 0); // interlace
  return buf;
}

/**
 * Minimal RFC 1950 zlib/deflate for tiny payloads.
 * Produces valid compressed data without needing a full deflate library.
 */
function deflateMinimal(data: Uint8Array): Uint8Array {
  // Store block (type 00) — no compression, just raw
  // RFC 1951: 3-bit header + aligned to byte + LEN + NLEN + data
  // We use a single "final" stored block
  const len = data.byteLength;
  const nlen = (~len) & 0xffff; // one's complement

  // Calculate adler32
  let a = 1, b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;

  // zlib wrapper: CMF(0x78) + FLG + compressed + adler32
  // CMF=0x78 → deflate, window=32K. FLG=0x01 → level=0, check bits
  const zlib = new Uint8Array(2 + 1 + 4 + len + 4); // CMF + FLG + bfinal+type + len/nlen + data + adler
  let pos = 0;
  zlib[pos++] = 0x78; // CMF
  zlib[pos++] = 0x01; // FLG
  zlib[pos++] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  zlib[pos++] = len & 0xff;
  zlib[pos++] = (len >> 8) & 0xff;
  zlib[pos++] = nlen & 0xff;
  zlib[pos++] = (nlen >> 8) & 0xff;
  zlib.set(data, pos); pos += len;
  zlib[pos++] = (adler >> 24) & 0xff;
  zlib[pos++] = (adler >> 16) & 0xff;
  zlib[pos++] = (adler >> 8) & 0xff;
  zlib[pos++] = adler & 0xff;

  return zlib;
}
