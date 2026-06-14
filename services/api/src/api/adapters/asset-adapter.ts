import type { AssetRuntimeApi } from "../contract/runtime-api.js";
import type { AssetService } from "../../domain/asset/asset-service.js";

export class AssetAdapter implements AssetRuntimeApi {
	constructor(private readonly assetService: AssetService) {}

	uploadAsset = (file: File) => this.assetService.upload(file);
	serveAsset = (assetId: string) => this.assetService.serve(assetId);
}
