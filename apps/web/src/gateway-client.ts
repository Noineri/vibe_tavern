export function getGatewayBaseUrl(): string {
  const configured = import.meta.env.VITE_RP_API_URL;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/+$/, "");
  }
  // Always use page origin in browser (works for localhost AND LAN IP on mobile)
  // Fall back to explicit dev URL only when SSR/no window
  return typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8787";
}
