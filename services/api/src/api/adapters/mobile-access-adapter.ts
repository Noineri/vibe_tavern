import type { MobileAccessRuntimeApi } from "../contract/runtime-api.js";
import type { MobileAccessService } from "../../domain/mobile-access/mobile-access-service.js";

export class MobileAccessAdapter implements MobileAccessRuntimeApi {
	constructor(private readonly mobileAccessService: MobileAccessService) {}

	async getMobileAccessInfo() {
		const port = Number(process.env.VIBE_TAVERN_PORT ?? "8787");
		const tlsEnabled = !!(process.env.VIBE_TAVERN_TLS_KEY && process.env.VIBE_TAVERN_TLS_CERT);
		return this.mobileAccessService.getMobileAccessInfo(port, tlsEnabled);
	}

	async regenerateMobileAccessToken(): Promise<{ token: string }> {
		const token = await this.mobileAccessService.regenerateToken();
		return { token };
	}

	async revokeMobileAccess(): Promise<{ token: null }> {
		await this.mobileAccessService.revokeToken();
		return { token: null };
	}
}
