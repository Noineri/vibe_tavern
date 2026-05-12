import { resolve } from "node:path";
import { unlink } from "node:fs/promises";

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
    const buffer = Buffer.from(await file.arrayBuffer());
    await Bun.write(filePath, buffer);
    return { assetId, url: `/api/assets/${assetId}` };
  }

  async serve(assetId: string): Promise<{ body: Buffer; contentType: string } | null> {
    // Prevent path traversal
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      return null;
    }
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      try {
        const bunFile = Bun.file(filePath);
        if (await bunFile.exists()) {
          return { body: Buffer.from(await bunFile.arrayBuffer()), contentType: EXT_TO_MIME[ext] };
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
      unlink(filePath).catch(() => {});
    }
  }
}
