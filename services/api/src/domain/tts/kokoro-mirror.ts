/**
 * @module tts/kokoro-mirror
 *
 * Server-side mirror for the in-browser Kokoro model repository
 * (TTS defects report, F4 / defect D4).
 *
 * The Kokoro Web Worker downloads the model files (ONNX weights, tokenizer,
 * and the per-voice blobs kokoro-js fetches from a hardcoded HF URL inside its
 * dist) directly from huggingface.co with browser `fetch`. Browser fetch can
 * use neither the process proxy nor the app's proxy registry, so in regions
 * where HF is geo-blocked the download stalls silently. This module serves the
 * SAME repository through the API server, so the traffic flows through the
 * app's existing proxy infrastructure (`provider-fetch-factory`, inherit =
 * global default proxy) exactly like every other outbound request. No new
 * proxy mechanism is introduced.
 *
 * Route shape: `GET /api/tts/kokoro/model/<repo-path>` → streams
 * `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/<repo-path>`.
 * The path is strictly validated (no traversal, no absolute paths, a tight
 * character allowlist) and the repository is a fixed constant — this is a
 * single-repo file mirror, never an open proxy.
 *
 * Caching: successful (200) responses are tee'd to a disk cache under
 * `<dataDir>/kokoro-model-cache/<repo-path>` while the body streams to the
 * client — the client keeps receiving chunks immediately, which the worker's
 * download watchdog requires. Later requests are served straight from disk.
 * HF redirects LFS files (302 → CDN); Bun's fetch follows redirects by default
 * on the plain/HTTP(S)-proxy transports, but the SOCKS5 bridge forces
 * `redirect: "manual"`, so redirects are followed HERE (HTTPS-only, bounded)
 * for every transport.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { PROXY_MODE } from "@vibe-tavern/domain";

import { getProviderFetchFactory, type ProviderFetch } from "../providers/provider-fetch-factory.js";

/** The one repository this mirror is allowed to serve (must match the Web
 *  Worker's MODEL_ID and the hardcoded voice URL inside kokoro-js dist). */
export const KOKORO_MIRROR_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Fixed upstream base — `<HF>/repo/resolve/main/`. */
const HF_BASE = `https://huggingface.co/${KOKORO_MIRROR_REPO}/resolve/main/`;

/** Disk cache subdirectory inside the app data dir. */
const CACHE_SUBDIR = "kokoro-model-cache";

/** Max manual redirect hops (only exercised behind the SOCKS5 bridge). */
const MAX_REDIRECTS = 5;

// ─── Path validation ──────────────────────────────────────────────────────

/**
 * Validate a repo-relative file path coming from the URL wildcard.
 * Returns the normalized path, or null when the path must be rejected
 * (empty, traversal, backslash, control characters, or characters outside
 * the repo's filename alphabet). This is the security boundary between the
 * public route and the disk cache / upstream URL.
 */
export function validateKokoroFilePath(raw: string): string | null {
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

/** Build the fixed upstream URL for a validated repo path. */
export function buildHuggingFaceUrl(repoPath: string): string {
	return HF_BASE + repoPath;
}

// ─── Result type ──────────────────────────────────────────────────────────

/** A successful mirror response body + headers ready for the HTTP layer. */
export interface KokoroMirrorFile {
	status: 200;
	contentType: string;
	contentLength: string;
	body: ReadableStream<Uint8Array>;
}

/** Everything the HTTP layer needs to answer a rejected / upstream-failed
 *  request without exposing internals. The literal status makes the union
 *  with {@link KokoroMirrorFile} properly discriminated. */
export interface KokoroMirrorError {
	status: 400 | 404 | 502;
	error: string;
}

export type KokoroMirrorResult = KokoroMirrorFile | KokoroMirrorError;

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ─── Service ──────────────────────────────────────────────────────────────

/** Deps kept injectable for deterministic tests. */
export interface KokoroMirrorDeps {
	/** Transport used for upstream requests (defaults to the proxy-aware
	 *  factory resolution — inherit = the app's global default proxy, or
	 *  plain fetch when none is configured). */
	resolveFetch?: () => Promise<ProviderFetch>;
	/** Clock is not needed; kept out deliberately. */
}

export class KokoroMirrorService {
	private readonly cacheRoot: string;
	private readonly deps: KokoroMirrorDeps;
	/** Single-flight: concurrent requests for the same path share one upstream
	 *  fetch instead of hammering the proxy with duplicate 92 MB downloads. */
	private readonly inFlight = new Map<string, Promise<KokoroMirrorResult>>();

	constructor(dataDir: string, deps?: KokoroMirrorDeps) {
		this.cacheRoot = join(dataDir, CACHE_SUBDIR);
		this.deps = deps ?? {};
	}

	private async resolveFetch(): Promise<ProviderFetch> {
		if (this.deps.resolveFetch) return this.deps.resolveFetch();
		// Inherit policy = the app's global default proxy (or direct when none
		// is configured). The factory is bound at server bootstrap to the live
		// proxy store; pre-bind, inherit resolves to direct — same as providers.
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
				throw new Error("Kokoro mirror redirect left HTTPS — rejected.");
			}
			current = next.href;
		}
		throw new Error("Kokoro mirror redirect limit exceeded.");
	}

	/** Serve one repo path. Safe to call concurrently — identical paths share
	 *  a single in-flight request. */
	handle(rawPath: string): Promise<KokoroMirrorResult> {
		const existing = this.inFlight.get(rawPath);
		if (existing) return existing;
		const promise = this.handleUncached(rawPath).finally(() => {
			this.inFlight.delete(rawPath);
		});
		this.inFlight.set(rawPath, promise);
		return promise;
	}

	private async handleUncached(rawPath: string): Promise<KokoroMirrorResult> {
		const repoPath = validateKokoroFilePath(rawPath);
		if (!repoPath) {
			return { status: 400, error: "Invalid model file path." };
		}

		const cachePath = join(this.cacheRoot, repoPath);
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
			upstream = await this.upstreamFetch(buildHuggingFaceUrl(repoPath));
		} catch {
			// Upstream/network failure — no internals in the message.
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
		// Node streams, verified against the pinned Bun: BOTH Bun write flavors
		// mishandle a tee'd web ReadableStream — `Bun.write(dest, s)` and
		// `Bun.file(dest).write(s)` silently STRINGIFY it ("[object ReadableStream]"
		// lands on disk), and wrapping in `new Response(s)` hangs forever. The
	// node path streams correctly.
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
