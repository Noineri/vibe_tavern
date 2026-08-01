import type { ProxyRuntimeApi } from "../contract/runtime-api.js";
import type { ClientProxyRecord } from "@vibe-tavern/api-contracts";
import type { ProxyService } from "../../domain/providers/proxy-service.js";
import { notFound } from "../../shared/errors.js";

export class ProxyAdapter implements ProxyRuntimeApi {
	constructor(
		private readonly proxyService: ProxyService,
	) {}

	listProxies = () => this.proxyService.listProxies();

	getProxy = async (proxyId: string): Promise<ClientProxyRecord> => {
		const proxy = await this.proxyService.getProxy(proxyId);
		if (!proxy) throw notFound("ProxyProfile", `Proxy '${proxyId}' was not found.`);
		return proxy;
	};

	saveProxy = (body: Record<string, unknown>) => this.proxyService.saveProxy(body);

	updateProxy = (proxyId: string, body: Record<string, unknown>) =>
		this.proxyService.updateProxy(proxyId, body);

	deleteProxy = (proxyId: string) => this.proxyService.deleteProxy(proxyId);

	reorderProxies = (updates: Array<{ id: string; sortOrder: number }>) =>
		this.proxyService.reorderProxies(updates);

	getDefaultProxy = async (): Promise<{ defaultProxyId: string | null }> => {
		const defaultProxyId = await this.proxyService.getDefaultProxyId();
		return { defaultProxyId };
	};

	setDefaultProxy = async (body: { defaultProxyId: string | null }): Promise<{ defaultProxyId: string | null }> => {
		return this.proxyService.setDefaultProxyId(body.defaultProxyId);
	};
}
