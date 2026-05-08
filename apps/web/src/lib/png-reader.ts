/**
 * Minimal PNG chunk extractor for Character Cards (V2/V3).
 * Works in the browser and Node.js using ArrayBuffer/Uint8Array.
 */

export interface PngMetadata {
  keyword: string;
  text: string;
}

export async function extractPngMetadata(file: File): Promise<PngMetadata[]> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
    throw new Error('Not a valid PNG file');
  }

  const metadata: PngMetadata[] = [];
  let offset = 8;

  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...uint8.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // Bounds check: prevent malformed chunks from reading past buffer
    if (dataEnd > buffer.byteLength) {
      break;
    }

    if (type === 'tEXt') {
      // tEXt: Keyword\0Text
      const chunkData = uint8.slice(dataStart, dataEnd);
      const nullIndex = chunkData.indexOf(0);
      if (nullIndex !== -1) {
        const keyword = new TextDecoder().decode(chunkData.slice(0, nullIndex));
        const text = new TextDecoder().decode(chunkData.slice(nullIndex + 1));
        metadata.push({ keyword, text });
      }
    } else if (type === 'iTXt') {
      // iTXt: Keyword\0CompressionFlag\0CompressionMethod\0LanguageTag\0TranslatedKeyword\0Text
      const chunkData = uint8.slice(dataStart, dataEnd);
      const null1 = chunkData.indexOf(0);
      if (null1 !== -1) {
        const keyword = new TextDecoder().decode(chunkData.slice(0, null1));
        const compressionFlag = chunkData[null1 + 1];

        let currentPos = null1 + 3; // Skip null, compression flag, compression method

        // Skip Language Tag
        while (currentPos < chunkData.length && chunkData[currentPos] !== 0) currentPos++;
        currentPos++;
        // Skip Translated Keyword
        while (currentPos < chunkData.length && chunkData[currentPos] !== 0) currentPos++;
        currentPos++;

        if (compressionFlag === 0) {
          // Uncompressed text
          const text = new TextDecoder().decode(chunkData.slice(currentPos));
          metadata.push({ keyword, text });
        } else if (compressionFlag === 1) {
          // zlib-compressed text (decompress via DecompressionStream)
          try {
            const compressed = chunkData.slice(currentPos);
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(compressed);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
            const combined = new Uint8Array(totalLength);
            let pos = 0;
            for (const chunk of chunks) {
              combined.set(chunk, pos);
              pos += chunk.length;
            }
            const text = new TextDecoder().decode(combined);
            metadata.push({ keyword, text });
          } catch {
            // Skip malformed compressed chunks
          }
        }
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // Skip length + type + data + CRC
  }

  return metadata;
}

/**
 * Try to decode a string that may be base64-encoded JSON, or raw JSON.
 * SillyTavern always base64-encodes both 'chara' (V2) and 'ccv3' (V3) chunks,
 * but some tools write raw JSON. Try both.
 */
function decodeCardText(text: string): unknown {
  // Try base64 first (standard SillyTavern encoding)
  try {
    const decoded = atob(text);
    return JSON.parse(decoded);
  } catch {
    // Not valid base64+JSON — try raw JSON
  }

  // Try raw JSON (non-standard but common)
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parses the extracted metadata into a Character object.
 * Supports SillyTavern V2 (chara) and V3 (ccv3).
 * V3 takes precedence. Falls back to V2 if V3 fails.
 */
export function parseCharacterMetadata(metadata: PngMetadata[]): unknown {
  // Try ccv3 (V3) first — SillyTavern writes this as base64-encoded JSON
  const v3 = metadata.find(m => m.keyword === 'ccv3');
  if (v3) {
    const parsed = decodeCardText(v3.text);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  }

  // Fall back to chara (V2)
  const v2 = metadata.find(m => m.keyword === 'chara');
  if (v2) {
    const parsed = decodeCardText(v2.text);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  }

  throw new Error('No character metadata found in PNG');
}
