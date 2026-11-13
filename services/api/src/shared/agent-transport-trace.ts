import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderFetch } from "../domain/providers/provider-fetch-factory.js";
import { getSendDebugLogDir } from "./send-debug-log.js";

export const AGENT_TRACE_HEADER = "x-vt-agent-trace";
const MAX_TRACE_BYTES = 64 * 1024 * 1024;

// forks: 1 — local-proxies/agy/agy-trace.ts (proxy ALS/raw-wire adapter).
/** Opt-in, local, content-bearing diagnostics; never include provider profiles or headers. */
export class AgentTransportTrace {
  readonly id = randomUUID();
  readonly path: string;
  private seq = 0;
  private fetchCount = 0;
  private bytes = 0;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory: string, metadata: Record<string, unknown>) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, `${this.id}.jsonl`);
    writeFileSync(this.path, "", { flag: "wx", mode: 0o600 });
    this.record("turn.start", metadata);
  }

  record(event: string, data: unknown): void {
    if (this.stopped) return;
    try {
      // Serialize NOW: later mutations of messages/store rows must not rewrite evidence.
      let line = JSON.stringify({ v: 1, id: this.id, seq: this.seq++, at: new Date().toISOString(), event, data }) + "\n";
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > MAX_TRACE_BYTES) {
        line = JSON.stringify({ id: this.id, seq: this.seq - 1, event: "trace.limit", data: { maxBytes: MAX_TRACE_BYTES } }) + "\n";
        this.stopped = true;
        console.warn(`[agent-trace] capture limit reached: ${this.path}`);
      }
      this.pending = this.pending.then(() => appendFile(this.path, line)).catch((error: unknown) => {
        this.stopped = true;
        console.warn(`[agent-trace] write failed: ${this.path}: ${String(error)}`);
      });
    } catch (error) {
      this.stopped = true;
      console.warn(`[agent-trace] serialization failed: ${String(error)}`);
    }
  }

  flush(): Promise<void> { return this.pending; }

  wrapFetch(base: ProviderFetch = fetch): ProviderFetch {
    const traced: ProviderFetch = async (input, init) => {
      const callId = `${this.id}.${++this.fetchCount}`;
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // Correlation is local-only: do not add custom fingerprint headers to real providers.
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) headers.set(AGENT_TRACE_HEADER, callId);
      this.record("http.request", {
        callId, url: url.origin + url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
        bodyCaptured: typeof init?.body === "string",
      });
      try {
        const response = await base(input, { ...init, headers });
        this.record("http.response", { callId, status: response.status, proxyTraceId: response.headers.get("x-agy-trace-id") });
        return response; // Do not clone/drain/rebuffer the provider's response.
      } catch (error) {
        this.record("http.error", { callId, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
    traced.preconnect = base.preconnect.bind(base);
    return traced;
  }
}

/** A marker is read per turn, so tracing can be disabled without a server restart. */
export function createAgentTransportTrace(
  metadata: Record<string, unknown>,
  directory?: string | null,
): AgentTransportTrace | undefined {
  try {
    let target = directory;
    if (target === undefined) {
      target = process.env.VT_AGENT_TRACE_DIR;
      if (!target) {
        try { target = readFileSync(join(getSendDebugLogDir(), "agent-trace.enabled"), "utf8").trim(); }
        catch { return undefined; /* No opt-in marker: leave the hot path unchanged. */ }
      }
    }
    return target ? new AgentTransportTrace(target, metadata) : undefined;
  } catch (error) {
    console.warn(`[agent-trace] cannot initialize capture: ${String(error)}`);
    return undefined;
  }
}
