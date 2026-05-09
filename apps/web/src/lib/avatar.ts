import { getGatewayBaseUrl } from "../gateway-client.js";

export function avatarUrl(assetId: string): string {
  return `${getGatewayBaseUrl()}/api/assets/${assetId}`;
}
