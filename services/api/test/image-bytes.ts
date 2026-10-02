/**
 * Minimal in-memory PNG factory for tests (LINK_BINDING_PERF LB-1B).
 *
 * Produces a real, decodable truecolor PNG using stored (uncompressed)
 * zlib blocks — big canvases exercise Bun.Image decode/encode without any
 * committed fixture or file from the owner's data/. Origin: the inline
 * encoder in avatar-thumbnail.test.ts (LB-1A), lifted here once the
 * adapter/scanner tests needed real images too (one source, no forks).
 */
function crc32(buf: Uint8Array): number {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i]!;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(typeBytes, 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

export function minimalPng(width: number, height: number, rgb: [number, number, number] = [200, 60, 60]): Uint8Array {
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, width);
	new DataView(ihdr.buffer).setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB

	const stride = width * 3 + 1; // filter byte 0 per scanline
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const row = raw.subarray(y * stride + 1, (y + 1) * stride);
		for (let x = 0; x < width; x++) {
			row[x * 3] = rgb[0];
			row[x * 3 + 1] = rgb[1];
			row[x * 3 + 2] = rgb[2];
		}
	}

	// zlib stream of stored blocks (≤ 65535 bytes each) + adler32.
	const blocks: Uint8Array[] = [];
	for (let off = 0; off < raw.length; off += 65535) {
		const n = Math.min(65535, raw.length - off);
		const last = off + n >= raw.length ? 1 : 0;
		const blk = new Uint8Array(5 + n);
		blk[0] = last;
		blk[1] = n & 0xff;
		blk[2] = (n >> 8) & 0xff;
		blk[3] = ~n & 0xff;
		blk[4] = (~n >> 8) & 0xff;
		blk.set(raw.subarray(off, off + n), 5);
		blocks.push(blk);
	}
	let a = 1;
	let b = 0;
	for (const byte of raw) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	const zlib = new Uint8Array(2 + blocks.reduce((sum, blk) => sum + blk.length, 0) + 4);
	zlib[0] = 0x78;
	zlib[1] = 0x01;
	let zo = 2;
	for (const blk of blocks) {
		zlib.set(blk, zo);
		zo += blk.length;
	}
	new DataView(zlib.buffer).setUint32(zo, ((b << 16) | a) >>> 0);

	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib),
		pngChunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let po = 0;
	for (const part of parts) {
		png.set(part, po);
		po += part.length;
	}
	return png;
}
