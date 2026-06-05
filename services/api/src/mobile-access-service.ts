import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import * as os from "os";
import * as dgram from "dgram";

// ── Types ───────────────────────────────────────────────────────────────

export interface IPResult {
  address: string;
  type: "primary" | "tailscale" | "fallback";
  interfaceName: string;
}

export interface MobileAccessInfo {
  ips: IPResult[];
  port: number;
  token: string | null;
  tlsEnabled: boolean;
}

interface MobileAccessConfig {
  token: string | null;
}

// ── IP Detection ────────────────────────────────────────────────────────

function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function getPrimaryIPViaUDP(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => { socket.close(); resolve(null); }, 50);
    socket.connect(53, "8.8.8.8", () => {
      clearTimeout(timeout);
      const address = socket.address().address;
      socket.close();
      resolve(address === "0.0.0.0" ? null : address);
    });
    socket.on("error", () => { clearTimeout(timeout); socket.close(); resolve(null); });
  });
}

export async function getRecommendedIPs(): Promise<IPResult[]> {
  const results: IPResult[] = [];

  // 0. Check VIBE_TAVERN_EXTERNAL_HOST env var
  const rawExternal = process.env.VIBE_TAVERN_EXTERNAL_HOST;
  if (rawExternal) {
    const cleaned = rawExternal.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "").trim();
    if (cleaned) {
      results.push({ address: cleaned, type: "primary", interfaceName: "env-configured" });
    }
  }

  // 1. UDP socket trick
  const defaultIP = await getPrimaryIPViaUDP();
  if (defaultIP && isPrivateIP(defaultIP)) {
    results.push({ address: defaultIP, type: "primary", interfaceName: "default-route" });
  }

  // 2. Scan interfaces
  const interfaces = os.networkInterfaces();
  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) continue;
    const lowerName = name.toLowerCase();
    if (["veth", "wsl", "hyper-v", "vmware", "virtualbox", "docker"].some(v => lowerName.includes(v))) continue;

    for (const net of nets) {
      if (net.family !== "IPv4" || net.internal || net.address.startsWith("169.254.")) continue;

      // Tailscale
      if (lowerName.includes("tailscale") || net.address.startsWith("100.")) {
        if (!results.find(r => r.address === net.address)) {
          results.push({ address: net.address, type: "tailscale", interfaceName: name });
        }
        continue;
      }

      // Private IPs as fallback
      if (isPrivateIP(net.address) && !results.find(r => r.address === net.address)) {
        results.push({ address: net.address, type: "fallback", interfaceName: name });
      }
    }
  }

  return results;
}

// ── Token Management ────────────────────────────────────────────────────

export class MobileAccessService {
  private configPath: string;
  private config: MobileAccessConfig;

  constructor(dataDir: string) {
    this.configPath = resolve(dataDir, "mobile-access.json");
    this.config = this.load();
  }

  private load(): MobileAccessConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf-8");
        return JSON.parse(raw);
      }
    } catch { /* ignore */ }
    return { token: null };
  }

  private save(): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getToken(): string | null {
    return this.config.token;
  }

  generateToken(): string {
    const token = crypto.randomUUID();
    this.config.token = token;
    this.save();
    return token;
  }

  regenerateToken(): string {
    return this.generateToken();
  }

  revokeToken(): void {
    this.config.token = null;
    this.save();
  }

  async getMobileAccessInfo(port: number, tlsEnabled: boolean): Promise<MobileAccessInfo> {
    const ips = await getRecommendedIPs();
    return { ips, port, token: this.config.token, tlsEnabled };
  }
}
