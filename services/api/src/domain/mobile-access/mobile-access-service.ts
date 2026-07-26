import { mkdir } from "node:fs/promises";
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
	private readonly configPath: string;
	private config: MobileAccessConfig = { token: null };
	// Serializes token mutations: concurrent generate/revoke calls interleave
	// their Bun.write() completions out of order, leaving disk and memory
	// diverged (e.g. a revoked token resurrecting after restart).
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(dataDir: string) {
		this.configPath = resolve(dataDir, "mobile-access.json");
	}

  static async create(dataDir: string): Promise<MobileAccessService> {
    const service = new MobileAccessService(dataDir);
    service.config = await service.load();
    return service;
  }

  private async load(): Promise<MobileAccessConfig> {
    try {
      return JSON.parse(await Bun.file(this.configPath).text());
    } catch {
      return { token: null };
    }
  }

	private async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await Bun.write(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getToken(): string | null {
    return this.config.token;
  }

	async generateToken(): Promise<string> {
		return this.enqueueMutation(async () => {
			const token = crypto.randomUUID();
			this.config.token = token;
			await this.save();
			return token;
		});
	}

	async regenerateToken(): Promise<string> {
		return this.generateToken();
	}

	async revokeToken(): Promise<void> {
		return this.enqueueMutation(async () => {
			this.config.token = null;
			await this.save();
		});
	}

	private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
		const run = this.mutationQueue.then(mutation);
		this.mutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

  async getMobileAccessInfo(port: number, tlsEnabled: boolean): Promise<MobileAccessInfo> {
    const ips = await getRecommendedIPs();
    return { ips, port, token: this.config.token, tlsEnabled };
  }
}
