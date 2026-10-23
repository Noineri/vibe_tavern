import type { AssetUploadResult } from "../../domain/asset/asset-service.js";

/**
 * Asset (attachment upload / serve) contract.
 *
 * Extracted into its own module per the file-size ratchet (runtime-api.ts
 * only re-exports it) when the upload result gained the text-file
 * `tokenCount` (COPILOT_ATTACHMENTS_PLAN CA-1a).
 */
export interface AssetRuntimeApi {
	/** Stores an image, audio clip or text file; text results carry `tokenCount`. */
	uploadAsset: (file: File) => Promise<AssetUploadResult>;
	serveAsset: (assetId: string) => Promise<Response | null>;
}
