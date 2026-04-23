const DEFAULT_API_URL = "http://127.0.0.1:8787";

export function getGatewayBaseUrl(): string {
  const configured = import.meta.env.VITE_RP_API_URL;
  return typeof configured === "string" && configured.trim()
    ? configured.trim().replace(/\/+$/, "")
    : DEFAULT_API_URL;
}
