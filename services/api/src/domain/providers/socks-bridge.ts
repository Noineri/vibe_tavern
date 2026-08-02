/**
 * @module providers/socks-bridge
 *
 * Lazy loopback HTTP bridge for SOCKS5 upstream proxies.
 *
 * Bun's native `fetch(..., { proxy })` accepts `http://`/`https://` proxy URLs
 * but NOT `socks5://`. Rather than implement the SOCKS protocol ourselves (or
 * use a fetch-replacement dispatcher that Bun does not honour), this module
 * uses the maintained `proxy-chain` library to spin up a short-lived local HTTP
 * proxy server (the "bridge") that forwards CONNECT tunnels through a selected
 * SOCKS5 upstream. Bun fetch remains the actual provider client — it just talks
 * to `http://127.0.0.1:<port>` (the bridge) instead of the SOCKS server.
 *
 * Design constraints enforced here:
 *
 *  - **Lazy**: a bridge is created only the first time a SOCKS5 proxy is
 *    actually used, never at startup, and only when a SOCKS5 upstream is
 *    actually selected (never for `direct`/HTTP(S) resolutions).
 *  - **Cached by full effective upstream config**: the cache key is a SHA-256
 *    of the complete upstream URL (host + port + username + password). Changed
 *    credentials or host therefore get a fresh bridge instead of reusing a
 *    stale one, while repeated identical calls reuse the same bridge (no leaked
 *    listeners / ports).
 *  - **Loopback only**: every bridge binds `127.0.0.1` so it is unreachable
 *    from the network.
 *  - **Unpredictable local credentials**: each bridge is protected by a random
 *    username/password pair generated with `crypto.randomBytes`. Bun fetch
 *    embeds them in the bridge URL userinfo so they travel as
 *    `Proxy-Authorization`; the bridge rejects any request whose credentials do
 *    not match. This prevents a stray local process from consuming the user's
 *    upstream SOCKS5 connection.
 *  - **No credential leakage**: errors thrown here carry no upstream or local
 *    credential content. `proxy-chain`'s own logging is disabled (`verbose:
 *    false`); cleanup-failure logging is a fixed, credential-free message.
 *  - **Deterministic, orphan-free shutdown**: {@link SocksBridgeManager.closeAll}
 *    sets a closing flag, awaits every in-flight creation, then closes every
 *    bound bridge. A bridge created while shutdown is in progress is closed
 *    instead of inserted, so no listener can outlive the manager. New
 *    acquisitions are rejected once close begins.
 *
 * The SOCKS5 → HTTPS-only restriction is NOT enforced here — it lives in the
 * fetch wrapper (`createProxiedFetch`, `socksBacked`) so it fires before any
 * network access. This module is transport-agnostic: it happily tunnels any
 * CONNECT target, but the caller guarantees only HTTPS targets reach it.
 */

import { createHash, randomBytes } from "node:crypto";
import { Server as ProxyChainServer } from "proxy-chain";

// ─── Public contract ──────────────────────────────────────────────────────

/** Minimal seam so the fetch factory can resolve a SOCKS5 upstream into a
 *  usable loopback HTTP bridge URL, and tests can inject a fake. */
export interface SocksBridgeLookup {
	/** Resolve a full effective upstream URL (`socks5://user:pass@host:port`)
	 *  to a loopback HTTP bridge URL (`http://localuser:localpass@127.0.0.1:p`).
	 *  Bridges are cached — repeated identical calls reuse the same listener.
	 *  Rejects once the manager has begun shutting down. */
	getOrCreateBridge(socksUrl: string): Promise<string>;
}

/** A bound loopback bridge the manager owns. The `bridgeUrl` is what Bun fetch
 *  uses (carries the local credentials); `close` forcibly tears the listener
 *  down. Extracted as an interface so lifecycle tests can inject a fake factory
 *  without spinning up real `proxy-chain` servers. */
export interface BridgeHandle {
	readonly bridgeUrl: string;
	/** Forcibly close the bridge listener. Should reject (not hang) once the
	 *  underlying server is gone. */
	close(force?: boolean): Promise<void>;
}

/** Factory that creates + binds one fresh bridge for an upstream SOCKS URL.
 *  The manager handles caching, dedup, and shutdown — the factory only binds. */
export interface SocksBridgeServerFactory {
	createAndListen(socksUrl: string): Promise<BridgeHandle>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Generate an unpredictable local credential for bridge authentication.
 *  18 bytes → 24 base64url chars — far beyond brute-forceable in the bridge's
 *  ephemeral lifetime. */
function makeLocalCredential(): string {
	return randomBytes(18).toString("base64url");
}

/** Deterministic cache key derived from the full effective upstream URL. Using
 *  a hash (not the raw URL) ensures the in-memory Map never stores upstream
 *  credentials in cleartext, even if the map were inspected or logged. */
function bridgeCacheKey(socksUrl: string): string {
	return createHash("sha256").update(socksUrl).digest("hex");
}

/** Credential-free log for a bridge that could not be closed. Never includes
 *  the upstream URL, the local credentials, or the underlying error object
 *  (which proxy-chain may embed a URL into). */
function logBridgeCloseFailure(): void {
	console.error("SOCKS5 proxy bridge: a listener could not be closed during shutdown.");
}

// ─── Production factory (proxy-chain loopback HTTP bridge) ─────────────────

/** The real bridge factory used in production. Builds a loopback HTTP proxy
 *  backed by the upstream SOCKS5 URL, protected by random local credentials,
 *  and returns a handle whose `close` delegates to `proxy-chain`'s forced
 *  close. This is the ONLY place production touches the SOCKS protocol — and
 *  it delegates entirely to a maintained library. */
const proxyChainBridgeFactory: SocksBridgeServerFactory = {
	async createAndListen(socksUrl: string): Promise<BridgeHandle> {
		// Unpredictable local credentials — Bun embeds these in the bridge URL
		// userinfo and sends them as Proxy-Authorization on every CONNECT.
		const localUser = makeLocalCredential();
		const localPass = makeLocalCredential();

		const server = new ProxyChainServer({
			port: 0,
			host: "127.0.0.1",
			verbose: false,
			prepareRequestFunction: ({ username, password }) => {
				if (username !== localUser || password !== localPass) {
					// Reject foreign local connections with a 407 challenge.
					return { requestAuthentication: true };
				}
				return {
					requestAuthentication: false,
					// The upstream SOCKS5 URL (with embedded credentials) is the
					// ONLY place upstream credentials appear — never logged.
					upstreamProxyUrl: socksUrl,
				};
			},
		});

		try {
			await server.listen();
		} catch {
			// Best-effort cleanup of the half-initialised server. A failure here
			// is logged generically (no credential content) and swallowed; the
			// caller wraps the rethrown generic error.
			try {
				await server.close(true);
			} catch {
				logBridgeCloseFailure();
			}
			// Sanitise: never include the upstream URL (credentials!) or the
			// underlying error (which may embed it). The factory layer wraps
			// this into a credential-free ProviderProxyError.
			throw new Error("Failed to start the SOCKS5 proxy bridge.");
		}

		const port = server.port;
		// The bridge URL Bun fetch uses — local credentials embedded here only.
		const bridgeUrl = `http://${encodeURIComponent(localUser)}:${encodeURIComponent(localPass)}@127.0.0.1:${port}`;
		return {
			bridgeUrl,
			close: async (force?: boolean) => {
				// proxy-chain's close(true) destroys its OWN tracked sockets, but a
				// CONNECT tunnel's source socket is detached from that tracking on
				// upgrade, so closeConnections() misses it and the underlying
				// http.Server.close() then waits for the lingering keep-alive socket
				// — a real hang after any proxied HTTPS request. Forcibly closing ALL
				// connections on the underlying server first makes the teardown
				// terminate deterministically. (Under Bun this also stops the server,
				// so the proxy-chain close is skipped when it would reject with
				// ERR_SERVER_NOT_RUNNING; under Node the guarded close(true) resolves
				// once the connections are gone.)
				const underlying = server.server;
				if (force && typeof underlying.closeAllConnections === "function") {
					underlying.closeAllConnections();
				}
				if (underlying.listening) {
					await server.close(force);
				}
			},
		};
	},
};

// ─── Manager ───────────────────────────────────────────────────────────────

interface BridgeEntry {
	readonly handle: BridgeHandle;
	readonly bridgeUrl: string;
}

/**
 * Owns the lifecycle of all SOCKS5 bridge servers in this process.
 *
 * Concurrency / shutdown invariants:
 *  - Concurrent `getOrCreateBridge` calls for the same upstream share ONE
 *    creation (dedup via the pending map).
 *  - Once {@link closeAll} begins, new acquisitions reject; in-flight creations
 *    are awaited and, if they finish during shutdown, closed rather than
 *    inserted — so no listener can outlive the manager.
 *  - `closeAll` attempts to close every bridge before throwing a single generic
 *    aggregate error; one bridge failing to close never skips the others.
 */
export class SocksBridgeManager implements SocksBridgeLookup {
	private readonly bridges = new Map<string, BridgeEntry>();
	/** In-flight bridge creations keyed identically, so concurrent callers for
	 *  the same upstream share one creation rather than racing to open two. */
	private readonly pending = new Map<string, Promise<string>>();
	private closing = false;
	private readonly factory: SocksBridgeServerFactory;

	constructor(factory: SocksBridgeServerFactory = proxyChainBridgeFactory) {
		this.factory = factory;
	}

	async getOrCreateBridge(socksUrl: string): Promise<string> {
		if (this.closing) {
			throw new Error("SOCKS5 proxy bridge manager is shutting down.");
		}
		const key = bridgeCacheKey(socksUrl);

		const existing = this.bridges.get(key);
		if (existing) return existing.bridgeUrl;

		let inflight = this.pending.get(key);
		if (!inflight) {
			inflight = this.createBridge(socksUrl, key);
			this.pending.set(key, inflight);
		}
		try {
			return await inflight;
		} finally {
			this.pending.delete(key);
		}
	}

	private async createBridge(socksUrl: string, key: string): Promise<string> {
		const handle = await this.factory.createAndListen(socksUrl);
		// If shutdown began while we were creating, close the just-bound bridge
		// instead of inserting an orphaned listener. There is no `await` between
		// this check and the `set` below, so in single-threaded JS the two are
		// atomic with respect to `closeAll`.
		if (this.closing) {
			try {
				await handle.close(true);
			} catch {
				logBridgeCloseFailure();
			}
			throw new Error("SOCKS5 proxy bridge manager closed during bridge creation.");
		}
		this.bridges.set(key, { handle, bridgeUrl: handle.bridgeUrl });
		return handle.bridgeUrl;
	}

	/** The number of active bridges — exposed for tests / diagnostics. */
	get size(): number {
		return this.bridges.size;
	}

	/** Close every bridge and reject all further acquisitions. A failure to
	 *  close one bridge is logged generically and does not prevent the others
	 *  from closing; if any close failed, a single credential-free aggregate
	 *  error is thrown after every close has been attempted. */
	async closeAll(): Promise<void> {
		this.closing = true;
		// Let every in-flight creation settle first: it will either self-close
		// (the closing flag is now set) or insert and be closed below. This is
		// what guarantees no listener is orphaned by a creation that finishes
		// after the map was cleared.
		const inflight = [...this.pending.values()];
		if (inflight.length > 0) {
			await Promise.allSettled(inflight);
		}
		const entries = [...this.bridges.values()];
		this.bridges.clear();
		this.pending.clear();

		let failures = 0;
		await Promise.all(
			entries.map(async (entry) => {
				try {
					await entry.handle.close(true);
				} catch {
					failures += 1;
					logBridgeCloseFailure();
				}
			}),
		);
		if (failures > 0) {
			throw new Error(`SOCKS5 bridge shutdown completed with ${failures} bridge close failure(s).`);
		}
	}
}

// ─── Process-wide singleton ────────────────────────────────────────────────

let activeManager: SocksBridgeManager | null = null;

/** The process-wide bridge manager. Created lazily on first use (only when a
 *  SOCKS5 upstream is actually selected — never for direct/HTTP resolutions). */
export function getSocksBridgeManager(): SocksBridgeManager {
	if (!activeManager) activeManager = new SocksBridgeManager();
	return activeManager;
}

/** Build an independent manager bound to a custom factory. Used by lifecycle
 *  tests so they never touch the process-wide singleton (no global state to
 *  clean up, no real ports bound unless the factory does so). */
export function createSocksBridgeManager(
	factory?: SocksBridgeServerFactory,
): SocksBridgeManager {
	return new SocksBridgeManager(factory);
}

/**
 * Close every active SOCKS5 bridge and reset the singleton. Wired into the real
 * server shutdown lifecycle (SIGINT/SIGTERM / post-update exit) by
 * `server-runtime`, which awaits it. After this resolves the singleton is null
 * again, so a subsequent acquisition creates a fresh, usable manager.
 */
export async function closeAllSocksBridges(): Promise<void> {
	const manager = activeManager;
	if (!manager) return;
	activeManager = null;
	await manager.closeAll();
}
