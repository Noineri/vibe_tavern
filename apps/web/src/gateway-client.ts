const DEFAULT_API_URL = "";  // empty = same origin (production: single server)
const DEV_API_URL = "http://127.0.0.1:8787";

export function getGatewayBaseUrl(): string {
  const configured = import.meta.env.VITE_RP_API_URL;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/+$/, "");
  }
  // In dev (Vite dev server) fall back to explicit API URL;
  // in production (single server) use same origin (empty string).
  return import.meta.env.DEV ? DEV_API_URL : DEFAULT_API_URL;
}
