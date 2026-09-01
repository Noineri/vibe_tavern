/**
 * @module stt/whisper-mirror
 *
 * Server-side mirror for the in-browser Whisper model repositories
 * (STT_PLAN ST-3; twin of `tts/kokoro-mirror.ts`).
 *
 * The Whisper Web Worker downloads model files (ONNX weights, tokenizer,
 * config) from huggingface.co with browser `fetch` — which can use neither
 * the process proxy nor the app's proxy registry. In regions where HF is
 * geo-blocked the download stalls silently. This module serves the SAME
 * repositories through the API server, so the traffic flows through the
 * app's existing proxy infrastructure (`provider-fetch-factory`, inherit =
 * global default proxy) exactly like every other outbound request. No new
 * proxy mechanism is introduced.
 *
 * Route shape: `GET /api/stt/whisper/model/<repo>/<repo-path>` → streams
 * `https://huggingface.co/<repo>/resolve/main/<repo-path>`. TWO security
 * boundaries: the `<repo>` segment must be in the WHISPER roster allowlist
 * (`whisperMirrorRepos()` — this is a fixed-repo-set file mirror, never an
 * open proxy), and `<repo-path>` gets the same strict validation as the
 * Kokoro mirror (no traversal, no absolute paths, tight character
 * allowlist).
 *
 * Caching: successful (200) responses are tee'd to a disk cache under
 * `<dataDir>/whisper-model-cache/<repo>/<repo-path>` while the body streams
 * to the client (the worker's download watchdog requires live chunks).
 * Later requests are served straight from disk. HF redirects LFS files
 * (302 → CDN); redirects are followed HERE (HTTPS-only, bounded) because
 * the SOCKS5-bridge transport forces `redirect: "manual"`.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { PROXY_MODE, whisperMirrorRepos } from "@vibe-tavern/domain";

import { getProviderFetchFactory, type ProviderFetch } from "../providers/provider-fetch-factory.js";

/** Fixed upstream base — `<HF>/<repo>/resolve/main/`. */
const HF_ORIGIN = "https://huggingface.co/";

/** Disk cache subdirectory inside the app data dir. */
const CACHE_SUBDIR = "whisper-model-cache";

/** Max manual redirect hops (only exercised behind the SOCKS5 bridge). */
const MAX_REDIRECTS = 5;

// ─── Path validation ──────────────────────────────────────────────────────

/**
 * Validate a repo file path coming from the URL wildcard. Returns the
 * normalized path, or null when the path must be rejected (empty, traversal,
 * backslash, control characters, or characters outside the repo's filename
 * alphabet). This is the security boundary between the public route and the
 * disk cache / upstream URL.
 */
export function validateWhisperFilePath(raw: string): string | null {
  const trimmed = raw.replaceAll("\\", "\u0000").trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  // Reject any character outside [A-Za-z0-9._-/] — covers control chars,
  // spaces, percent tricks (the path is used verbatim, never decoded).
  if (!/^[A-Za-z0-9._\-/]+$/.test(trimmed)) return null;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

/** The mirror's repository allowlist (the whisper roster — same list the
 *  worker's URL rewriter matches). */
export function whisperMirrorAllowlist(): readonly string[] {
  return whisperMirrorRepos();
}

/** True when `repo` is one of the mirrored repositories. */
export function isMirroredWhisperRepo(repo: string): boolean {
  return whisperMirrorRepos().includes(repo);
}

/** Build the fixed upstream URL for a validated repo + path. */
export function buildWhisperHuggingFaceUrl(repo: string, repoPath: string): string {
  return `${HF_ORIGIN}${repo}/resolve/main/${repoPath}`;
}

// ─── Result type ──────────────────────────────────────────────────────────

/** A successful mirror response body + headers ready for the HTTP layer. */
export interface WhisperMirrorFile {
  status: 200;
  contentType: string;
  contentLength: string;
  body: ReadableStream<Uint8Array>;
}

export interface WhisperMirrorError {
  status: 400 | 404 | 502;
  error: string;
}

export type WhisperMirrorResult = WhisperMirrorFile | WhisperMirrorError;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ─── Service ──────────────────────────────────────────────────────────────

/** Deps kept injectable for deterministic tests. */
export interface WhisperMirrorDeps {
  /** Transport used for upstream requests (defaults to the proxy-aware
   *  factory resolution — inherit = the app's global default proxy, or
   *  plain fetch when none is configured). */
  resolveFetch?: () => Promise<ProviderFetch>;
}

export class WhisperMirrorService {
  private readonly cacheRoot: string;
  private readonly deps: WhisperMirrorDeps;
  /** Single-flight: concurrent requests for the same repo path share one
   *  upstream fetch instead of hammering the proxy with duplicate
   *  multi-hundred-MB downloads. */
  private readonly inFlight = new Map<string, Promise<WhisperMirrorResult>>();

  constructor(dataDir: string, deps?: WhisperMirrorDeps) {
    this.cacheRoot = join(dataDir, CACHE_SUBDIR);
    this.deps = deps ?? {};
  }

  private async resolveFetch(): Promise<ProviderFetch> {
    if (this.deps.resolveFetch) return this.deps.resolveFetch();
    const factory = getProviderFetchFactory();
    const fetchFn = await factory.resolveFetch({
      proxyMode: PROXY_MODE.inherit,
      proxyId: null,
    });
    return fetchFn ?? fetch;
  }

  /** Fetch upstream, following redirects manually so the SOCKS5-bridge
   *  transport (`redirect: "manual"`) stays correct. Non-HTTPS redirect
   *  targets are rejected (the same HTTPS-only contract as the bridge). */
  private async upstreamFetch(url: string): Promise<Response> {
    const fetchFn = await this.resolveFetch();
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchFn(current, { redirect: "manual" });
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response; // malformed 3xx — surface as-is
      const next = new URL(location, current);
      if (next.protocol !== "https:") {
        throw new Error("Whisper mirror redirect left HTTPS — rejected.");
      }
      current = next.href;
    }
    throw new Error("Whisper mirror redirect limit exceeded.");
  }

  /** Serve one repo path. Safe to call concurrently — identical paths share
   *  a single in-flight request. */
  handle(repo: string, rawPath: string): Promise<WhisperMirrorResult> {
    const key = `${repo}/${rawPath}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.handleUncached(repo, rawPath).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async handleUncached(repo: string, rawPath: string): Promise<WhisperMirrorResult> {
    if (!isMirroredWhisperRepo(repo)) {
      return { status: 400, error: "Unknown model repository." };
    }
    const repoPath = validateWhisperFilePath(rawPath);
    if (!repoPath) {
      return { status: 400, error: "Invalid model file path." };
    }

    const cachePath = join(this.cacheRoot, repo, repoPath);
    const cached = await Bun.file(cachePath).exists();
    if (cached) {
      const file = Bun.file(cachePath);
      return {
        status: 200,
        contentType: guessContentType(repoPath),
        contentLength: String(file.size),
        body: file.stream() as ReadableStream<Uint8Array>,
      };
    }

    let upstream: Response;
    try {
      upstream = await this.upstreamFetch(buildWhisperHuggingFaceUrl(repo, repoPath));
    } catch {
      return { status: 502, error: "Model repository is unreachable." };
    }
    if (upstream.status !== 200 || !upstream.body) {
      // Pass the status through (404 for a nonexistent file etc.) without
      // caching and without leaking upstream headers.
      return { status: upstream.status === 404 ? 404 : 502, error: "Model file not available." };
    }

    // Tee: one branch streams to the client (progress watchdog stays fed),
    // the other lands in the disk cache atomically (tmp + rename).
    const [toClient, toDisk] = upstream.body.tee();
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("content-length") ?? "";

    void this.persistToCache(cachePath, toDisk).catch(() => {
      // Cache write failures are non-fatal — next request retries upstream.
    });

    return {
      status: 200,
      contentType,
      contentLength,
      body: toClient,
    };
  }

  private async persistToCache(cachePath: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const tmpPath = cachePath + ".tmp";
    await mkdir(dirname(cachePath), { recursive: true });
    // Node streams, verified against the pinned Bun (Kokoro mirror lesson):
    // BOTH Bun write flavors mishandle a tee'd web ReadableStream — silently
    // stringify it or hang forever. The node path streams correctly.
    // Boundary cast (justified): TS sees a DOM ReadableStream, fromWeb wants
    // the structurally-identical node:stream/web type — runtime-identical in
    // Bun. Narrow cast, never `any`.
    const nodeStream = Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream);
    await new Promise<void>((resolve, reject) => {
      const writer = createWriteStream(tmpPath);
      nodeStream.pipe(writer);
      writer.on("finish", () => resolve());
      writer.on("error", reject);
      nodeStream.on("error", reject);
    });
    await rename(tmpPath, cachePath);
  }
}

/** Minimal extension → MIME map (cache hits have no upstream headers). */
function guessContentType(repoPath: string): string {
  if (repoPath.endsWith(".json")) return "application/json";
  if (repoPath.endsWith(".onnx")) return "application/octet-stream";
  if (repoPath.endsWith(".bin")) return "application/octet-stream";
  if (repoPath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
