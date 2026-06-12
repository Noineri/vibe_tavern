import type { AssetRuntimeApi } from "../routes/types.js";
import type { AssetService } from "../asset-service.js";

export class AssetAdapter implements AssetRuntimeApi {
	constructor(private readonly assetService: AssetService) {}

	uploadAsset = (file: File) => this.assetService.upload(file);
	serveAsset = (assetId: string) => this.assetService.serve(assetId);
}
