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
        // Simple skip to the text part (after 4 more null-terminated/fixed fields)
        // In ST/Janitor, we mostly care about 'chara' keyword
        let currentPos = null1 + 3; // Skip null, compression flag, compression method

        // Skip Language Tag
        while (currentPos < chunkData.length && chunkData[currentPos] !== 0) currentPos++;
        currentPos++;
        // Skip Translated Keyword
        while (currentPos < chunkData.length && chunkData[currentPos] !== 0) currentPos++;
        currentPos++;

        const text = new TextDecoder().decode(chunkData.slice(currentPos));
        metadata.push({ keyword, text });
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // Skip length + type + data + CRC
  }

  return metadata;
}

/**
 * Parses the extracted metadata into a Character object.
 * Supports SillyTavern V2 (base64) and V3 (json).
 */
export function parseCharacterMetadata(metadata: PngMetadata[]): any {
  // Prefer ccv3 (V3) over chara (V2)
  const v3 = metadata.find(m => m.keyword === 'ccv3');
  if (v3) {
    return JSON.parse(v3.text);
  }

  const v2 = metadata.find(m => m.keyword === 'chara');
  if (v2) {
    try {
      // V2 is usually Base64 encoded JSON
      const decoded = atob(v2.text);
      return JSON.parse(decoded);
    } catch {
      // Sometimes it's raw JSON if not following strict spec
      return JSON.parse(v2.text);
    }
  }

  throw new Error('No character metadata found in PNG');
}
