import { hc } from "hono/client";
import type { AppType } from "@vibe-tavern/api";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { getMobileToken } from "../lib/mobile-token.js";

export const client = hc<AppType>(getGatewayBaseUrl(), {
  headers: () => {
    const token = getMobileToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
});

export { getGatewayBaseUrl, getMobileToken };
