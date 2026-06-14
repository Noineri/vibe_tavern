import type { MobileAccessRuntimeApi } from "../contract/runtime-api.js";
import type { MobileAccessService } from "../../domain/mobile-access/mobile-access-service.js";

export class MobileAccessAdapter implements MobileAccessRuntimeApi {
	constructor(private readonly mobileAccessService: MobileAccessService) {}

	async getMobileAccessInfo() {
		const port = Number(process.env.RP_PLATFORM_PORT ?? "8787");
		const tlsEnabled = !!(process.env.RP_PLATFORM_TLS_KEY && process.env.RP_PLATFORM_TLS_CERT);
		return this.mobileAccessService.getMobileAccessInfo(port, tlsEnabled);
	}

	async regenerateMobileAccessToken(): Promise<{ token: string }> {
		const token = this.mobileAccessService.regenerateToken();
		return { token };
	}

	async revokeMobileAccess(): Promise<{ token: null }> {
		this.mobileAccessService.revokeToken();
		return { token: null };
	}
}
