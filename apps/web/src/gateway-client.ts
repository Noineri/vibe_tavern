function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]";
}

export function getGatewayBaseUrl(): string {
  const configured = import.meta.env.VITE_RP_API_URL;
  const hasWindow = typeof window !== "undefined";

  if (typeof configured === "string" && configured.trim()) {
    const normalized = normalizeBaseUrl(configured);

    // Production/mobile builds may accidentally carry a loopback VITE_RP_API_URL.
    // On a phone, 127.0.0.1/localhost means the phone itself, not the desktop server,
    // so prefer the page origin when the app was opened from a LAN/Tailscale address.
    if (hasWindow) {
      try {
        const configuredUrl = new URL(normalized);
        const pageHost = window.location.hostname;
        if (!isLoopbackHost(pageHost) && isLoopbackHost(configuredUrl.hostname)) {
          return window.location.origin;
        }
      } catch {
        // Invalid env value: fall back to same-origin browser behavior below.
        return window.location.origin;
      }
    }

    return normalized;
  }

  // Always use page origin in browser (works for localhost AND LAN IP on mobile).
  // Fall back to explicit dev URL only when SSR/no window.
  return hasWindow ? window.location.origin : "http://127.0.0.1:8787";
}
