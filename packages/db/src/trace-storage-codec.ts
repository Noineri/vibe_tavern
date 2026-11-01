/** SQLite permits legacy TEXT and v2 BLOB values in the same declared column. */
export type StoredTraceText = string | Uint8Array;

export function isCompressedTraceText(value: StoredTraceText): boolean {
  return typeof value !== 'string' && value[0] === 0x28 && value[1] === 0xb5 && value[2] === 0x2f && value[3] === 0xfd;
}

export function compressTraceText(text: string): Buffer {
  return Buffer.from(Bun.zstdCompressSync(Buffer.from(text), { level: 3 }));
}

export function decodeTraceText(value: StoredTraceText): string {
  if (typeof value === 'string') return value;
  const bytes = isCompressedTraceText(value) ? Bun.zstdDecompressSync(value) : value;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
