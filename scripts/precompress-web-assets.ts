import { extname, join } from "node:path";
import { brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gzipBytes = promisify(gzip);
// WOFF/WOFF2, images, WASM and source maps are deliberately excluded.
const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".css", ".svg", ".json", ".ttf", ".otf"]);

/** Runs after bundling AND public-file copying, so workers and public fonts
 * receive the same siblings as the HTML graph's emitted assets. */
export async function precompressWebAssets(webDir: string): Promise<number> {
	let written = 0;
	for await (const relative of new Bun.Glob("{assets,fonts}/**/*").scan({ cwd: webDir, onlyFiles: true })) {
		if (!COMPRESSIBLE_EXTENSIONS.has(extname(relative).toLowerCase())) continue;
		const path = join(webDir, relative);
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		const variants = await Promise.all([brotli(bytes), gzipBytes(bytes)]);
		for (const [index, extension] of ["br", "gz"].entries()) {
			const compressed = variants[index]!;
			if (compressed.byteLength >= bytes.byteLength) continue;
			await Bun.write(`${path}.${extension}`, compressed);
			written++;
		}
	}
	return written;
}
