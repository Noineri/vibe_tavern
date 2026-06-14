import { resolve } from "node:path";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const ALLOWED_MIMES = new Set(Object.keys(MIME_TO_EXT));

/** Maximum upload size for images (20 MB — most providers cap at this). */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

export class AssetService {
  constructor(private readonly assetsDir: string) {}

  async upload(file: File): Promise<{ assetId: string; url: string }> {
    const mime = file.type;
    if (!ALLOWED_MIMES.has(mime)) {
      throw new Error(`Unsupported image type: ${mime}. Allowed: jpeg, png, gif, webp.`);
    }
    const ext = MIME_TO_EXT[mime];
    const assetId = `asset_${crypto.randomUUID().replace(/-/g, "")}`;
    const fileName = `${assetId}.${ext}`;
    const filePath = resolve(this.assetsDir, fileName);
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB. Maximum: 20 MB.`);
    }
    await Bun.write(filePath, buffer);
    return { assetId, url: `/api/assets/${assetId}` };
  }

  async serve(assetId: string): Promise<Response | null> {
    // Prevent path traversal
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      return null;
    }
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      try {
        const bunFile = Bun.file(filePath);
        // Eagerly read the file to avoid TOCTOU race with cleanup() unlink:
        // new Response(Bun.file()) is lazy — the file is opened when the response
        // is sent, which can race with a pending unlink() from a concurrent delete.
        const buffer = new Uint8Array(await bunFile.arrayBuffer());
        if (buffer.length > 0) {
          return new Response(buffer, {
            headers: {
              "Content-Type": EXT_TO_MIME[ext],
              "Cache-Control": "public, max-age=31536000",
            },
          });
        }
      } catch {
        // try next extension
      }
    }
    return null;
  }

  /** Load an attachment asset as a Buffer (for vision gate image processing). */
  async loadBuffer(assetId: string): Promise<Buffer | null> {
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      return null;
    }
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      try {
        const bunFile = Bun.file(filePath);
        const buffer = await bunFile.arrayBuffer();
        if (buffer.byteLength > 0) {
          return Buffer.from(buffer);
        }
      } catch {
        // try next extension
      }
    }
    return null;
  }

  cleanup(assetId: string | null | undefined): void {
    if (!assetId) return;
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      Bun.file(filePath).unlink().catch(() => {});
    }
  }
}
