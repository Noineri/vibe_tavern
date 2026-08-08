/**
 * SOCKS5 provider proxy traversal tests.
 *
 * Proves the proxy-chain loopback HTTP bridge correctly tunnels provider HTTPS
 * traffic through an authenticated SOCKS5 upstream, with Bun fetch as the
 * actual client. Covers: bare socks5 URL validation, separate stored credential
 * authentication, remote DNS through SOCKS (domain ATYP), gateway + AI SDK
 * traversal, live streaming with a deliberately delayed second chunk, AbortSignal
 * propagation, fail-closed on wrong upstream credentials, HTTPS-only rejection of
 * HTTP targets before any fixture/target contact, direct bypass, credential-free
 * error messages, and bridge caching (same-config reuse + changed-config rebuild).
 *
 * Test-only isolation choices that differ from the HTTP(S) traversal suite:
 *  - The provider target hostname is `provider.test` (a non-loopback RFC 2606
 *    reserved name). Bun bypasses the explicit `proxy` option for loopback
 *    targets (standard no_proxy behaviour), so a loopback target would let the
 *    request slip past the bridge and invalidate the test. `provider.test` is
 *    not loopback, so Bun honours the proxy; it never resolves the name locally
 *    because CONNECT carries the hostname to the bridge (remote DNS). The SOCKS
 *    fixture's custom connector routes that recorded hostname/port to the real
 *    loopback test target. No `NO_PROXY` / proxy-cache mutation is used.
 *  - The SOCKS5 upstream itself is a real SOCKS5 server from the maintained,
 *    test-only `@e9x/simple-socks` library (auth + custom connect). Production
 *    never implements SOCKS protocol bytes; it uses `proxy-chain`.
 *  - The committed test certificate's SAN includes `provider.test`, trusted via
 *    the existing per-request `tls.ca` injection. No global CA/env changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateText, streamText } from "ai";
import {
	isValidProxyUrl,
	PROXY_MODE,
	type StoredProxyRecord,
} from "@vibe-tavern/domain";
import { connect as netConnect, isIP, type Server as NetServer, type Socket } from "node:net";
import { createProxyServer, waitForConnect } from "@e9x/simple-socks";
import { listProviderModels } from "../src/domain/providers/provider-gateway.js";
import {
	createProviderFetchFactory,
	ProviderProxyError,
	resetProviderFetchFactory,
	resolveProviderFetchForProfile,
	setProviderFetchFactory,
	type ProxyLookup,
} from "../src/domain/providers/provider-fetch-factory.js";
import {
	closeAllSocksBridges,
	createSocksBridgeManager,
	getSocksBridgeManager,
	type BridgeHandle,
} from "../src/domain/providers/socks-bridge.js";
import { resolveModel } from "../src/infrastructure/ai/provider-executor-utils.js";

const TARGET_CERT = Bun.file(new URL("./fixtures/provider-proxy-cert.pem", import.meta.url));
const TARGET_KEY = Bun.file(new URL("./fixtures/provider-proxy-key.pem", import.meta.url));

const SOCKS_USER = "socks-upstream-user";
const SOCKS_PASS = "socks-upstream-secret";
/** Non-loopback target hostname (in the test cert SAN). Bun will NOT bypass the
 *  explicit proxy for it, and CONNECT carries it to the bridge unresolved. */
const TARGET_HOST = "provider.test";

// ─── Delayed-stream constants ──────────────────────────────────────────────
/**
 * Gap between the first and second SSE chunks — proves streaming is live.
 *
 * Generous on purpose. The streaming pin below is an ORDERING check, not a
 * latency budget, so this gap only has to outlast the scheduler stall between
 * the client receiving chunk one and the test observing it. Windows CI runners
 * routinely stall for seconds at a time; the previous 300 ms gap with a 150 ms
 * first-chunk deadline turned one such stall into a red build (171 ms measured).
 */
const STREAM_DELAY_MS = 1_500;

/**
 * Flipped by the fixture the instant it produces the delayed second chunk.
 *
 * The streaming test reads it once the FIRST chunk has arrived: still `false`
 * means the client had chunk one before the server had even written chunk two,
 * which is exactly what "not buffered" means — and it stays true regardless of
 * how slow the machine is. Reset per response; the tests in this file run
 * sequentially, so a single module-level flag is unambiguous.
 */
let secondChunkSent = false;

// ─── HTTPS target (the provider endpoint) ──────────────────────────────────

function targetResponse(request: Request): Response | Promise<Response> {
	const path = new URL(request.url).pathname;
	if (request.method === "GET" && path.endsWith("/models")) {
		return Response.json({ data: [{ id: "test-model", display_name: "Test model" }] });
	}
	return request.text().then((body) => {
		const wantsStream = /"stream"\s*:\s*true/.test(body);
		if (path.endsWith("/chat/completions")) {
			if (wantsStream) return delayedStreamResponse();
			return Response.json({
				id: "chat_1",
				object: "chat.completion",
				created: 0,
				model: "test-model",
				choices: [{ index: 0, message: { role: "assistant", content: "chat reply" }, finish_reason: "stop" }],
			});
		}
		return new Response("Not found", { status: 404 });
	});
}

/** A streaming OpenAI SSE response whose first chunk is sent immediately and
 *  whose second chunk is delayed by {@link STREAM_DELAY_MS}. */
function delayedStreamResponse(): Response {
	const firstChunk = `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "early" }, finish_reason: null }] })}\n\n`;
	const secondChunk = `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { content: "-delayed" }, finish_reason: "stop" }] })}\n\n`;
	secondChunkSent = false;
	return new Response(
		new ReadableStream({
			async start(controller) {
				const enc = new TextEncoder();
				controller.enqueue(enc.encode(firstChunk));
				await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
				secondChunkSent = true;
				controller.enqueue(enc.encode(secondChunk));
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

// ─── SOCKS5 upstream fixture (@e9x/simple-socks) ───────────────────────────

interface SocksConnectRecord {
	readonly host: string;
	readonly port: number;
	/** True when the destination arrived as a domain name (ATYP=3, remote DNS)
	 *  rather than an IP literal. */
	readonly viaDomain: boolean;
}

interface SocksAuthRecord {
	readonly username: string;
	readonly password: string;
	readonly accepted: boolean;
}

interface SocksFixture {
	/** `https://provider.test:<port>` — the URL provider requests use. */
	readonly targetUrl: string;
	readonly targetPort: number;
	/** Plain-HTTP loopback target for direct-mode coverage (no TLS, no proxy). */
	readonly httpTargetUrl: string;
	readonly socksUrl: string;
	readonly connects: SocksConnectRecord[];
	readonly authAttempts: SocksAuthRecord[];
	/** Explicit hit counter for the plain-HTTP loopback target — proves in the
	 *  HTTPS→HTTP redirect-escape regression test that the HTTP target is never
	 *  contacted, tracked directly rather than inferred from an error. */
	readonly httpTargetHits: { count: number };
	stop(): void;
}

/**
 * A real SOCKS5 server (RFC 1928 + RFC 1929 auth) from the maintained
 * `@e9x/simple-socks` library — NOT hand-rolled protocol bytes. It:
 *  - authenticates with a fixed username/password, recording every attempt;
 *  - records every CONNECT destination, flagging domain vs IP (remote DNS);
 *  - custom-connects the recorded hostname/port to the loopback TLS target, so
 *    `provider.test` (which has no DNS entry) reaches the real test server.
 *
 * Production continues to use `proxy-chain`; this fixture exists only so the
 * traversal tests exercise a standards-conformant SOCKS5 peer that does not
 * assume one-TCP-segment-per-message.
 */
function startSocksFixture(): SocksFixture {
	const connects: SocksConnectRecord[] = [];
	const authAttempts: SocksAuthRecord[] = [];
	/** Every socket the fixture opened, so stop() can force-tear them down. */
	const openSockets = new Set<Socket>();
	/** Explicit hit counter for the plain-HTTP loopback target. Proves the
	 *  redirect-escape regression that the HTTP target is never contacted. */
	const httpTargetHits = { count: 0 };
	/** The loopback HTTP target URL, captured once the server binds so the HTTPS
	 *  target's redirect endpoint can point at it. */
	let httpTargetUrlValue = "";

	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { cert: TARGET_CERT, key: TARGET_KEY },
		fetch: (request) => {
			const path = new URL(request.url).pathname;
			// Redirect-escape regression endpoint: returns a 302 whose Location
			// is a loopback plain-HTTP target. With redirect: "manual" (forced for
			// SOCKS-backed fetch), Bun must return this 3xx as-is and never follow
			// it — the HTTP target should receive zero requests and no second
			// SOCKS CONNECT should occur.
			if (request.method === "GET" && path.endsWith("/redirect-to-http")) {
				return new Response(null, {
					status: 302,
					headers: { Location: `${httpTargetUrlValue}/v1/models` },
				});
			}
			return targetResponse(request);
		},
	});

	// A plain-HTTP target for direct-mode tests (no TLS trust needed). Every hit
	// is tracked explicitly so the redirect-escape test can assert zero contact.
	const httpTarget = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			httpTargetHits.count += 1;
			return targetResponse(request);
		},
	});

	httpTargetUrlValue = `http://127.0.0.1:${httpTarget.port}`;

	const socks = createProxyServer({
		authenticate: (username, password) => {
			const accepted = username === SOCKS_USER && password === SOCKS_PASS;
			authAttempts.push({ username, password, accepted });
			return accepted;
		},
		connect: async (port, host) => {
			// Record exactly what the SOCKS5 client asked for. viaDomain proves
			// the hostname was forwarded unresolved (remote DNS through SOCKS).
			connects.push({ host, port, viaDomain: isIP(host) === 0 });
			// Route the (possibly non-resolvable) recorded hostname to the real
			// loopback TLS target. The destination port equals the target port
			// because the provider URL embeds target.port.
			const upstream = netConnect({ host: "127.0.0.1", port });
			openSockets.add(upstream);
			upstream.on("close", () => openSockets.delete(upstream));
			await waitForConnect(upstream);
			return upstream;
		},
	}) as NetServer;

	socks.on("connection", (socket) => {
		openSockets.add(socket);
		socket.on("close", () => openSockets.delete(socket));
	});

	socks.listen(0, "127.0.0.1");
	const socksPort = (socks.address() as { port: number }).port;

	return {
		targetUrl: `https://${TARGET_HOST}:${target.port}`,
		targetPort: target.port,
		httpTargetUrl: `http://127.0.0.1:${httpTarget.port}`,
		socksUrl: `socks5://127.0.0.1:${socksPort}`,
		connects,
		authAttempts,
		httpTargetHits,
		stop: () => {
			for (const socket of openSockets) socket.destroy();
			openSockets.clear();
			target.stop(true);
			httpTarget.stop(true);
			socks.close();
		},
	};
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/** A transport fetch that trusts the test HTTPS target's certificate (whose SAN
 *  includes `provider.test`) via the existing per-request CA injection. */
function createTrustedFetch(): typeof fetch {
	const trusted = ((input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, { ...init, tls: { ca: [TARGET_CERT] } })) as typeof fetch;
	trusted.preconnect = () => {};
	return trusted;
}

/** Build a ProxyLookup whose proxy "socks" points at the fixture SOCKS5 upstream
 *  with the given credentials. */
function socksLookup(
	socksUrl: string,
	username: string = SOCKS_USER,
	password: string = SOCKS_PASS,
): ProxyLookup {
	const record: StoredProxyRecord = {
		id: "socks",
		name: "SOCKS5 test proxy",
		url: socksUrl,
		username,
		password,
		sortOrder: 0,
		createdAt: "",
		updatedAt: "",
	};
	return {
		getById: async (id) => (id === record.id ? record : null),
		getDefaultProxyId: async () => null,
	};
}

/** Bind the active factory to the fixture SOCKS5 proxy + trusted TLS transport,
 *  then resolve the profile's fetch. */
async function socksFetch(
	fixture: SocksFixture,
	username: string = SOCKS_USER,
	password: string = SOCKS_PASS,
): Promise<typeof fetch> {
	setProviderFetchFactory(
		createProviderFetchFactory(socksLookup(fixture.socksUrl, username, password), createTrustedFetch()),
	);
	const fetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "socks" });
	if (!fetch) throw new Error("Expected a SOCKS5 proxy fetch.");
	return fetch;
}

/** Fully consume a response body so the keep-alive connection through the bridge
 *  is released for a clean teardown. A no-op once the body has already been read
 *  (e.g. via `.text()`), since reading already completes the transaction. */
async function drain(response: Response): Promise<void> {
	if (response.body && !response.bodyUsed) {
		await response.body.cancel();
	}
}

// ─── Traversal tests ───────────────────────────────────────────────────────

describe("SOCKS5 provider proxy traversal", () => {
	let fixture: SocksFixture;

	beforeAll(() => {
		// No NO_PROXY / proxy-cache mutation: provider.test is non-loopback, so
		// Bun honours the explicit per-request proxy and CONNECT carries the
		// hostname unresolved to the bridge.
		fixture = startSocksFixture();
	});

	afterAll(async () => {
		await closeAllSocksBridges();
		resetProviderFetchFactory();
		fixture.stop();
	});

	beforeEach(async () => {
		resetProviderFetchFactory();
		// Awaited (not fire-and-forget): force-closes every bridge listener so
		// the next test starts from a clean manager. proxy-chain's close(true)
		// forcibly tears down pending connections, so this terminates.
		await closeAllSocksBridges();
		fixture.connects.length = 0;
		fixture.authAttempts.length = 0;
		fixture.httpTargetHits.count = 0;
	});

	// ── URL validation parity ──────────────────────────────────────────────

	it("accepts a bare socks5 URL and rejects embedded userinfo/path/query", () => {
		expect(isValidProxyUrl("socks5://proxy.example:1080")).toBe(true);
		expect(isValidProxyUrl("socks5://127.0.0.1:1080")).toBe(true);
		// Embedded userinfo is rejected (credentials live in separate columns).
		expect(isValidProxyUrl("socks5://user:pass@127.0.0.1:1080")).toBe(false);
		// Path / query / fragment are rejected.
		expect(isValidProxyUrl("socks5://127.0.0.1:1080/path")).toBe(false);
		expect(isValidProxyUrl("socks5://127.0.0.1:1080?q=1")).toBe(false);
		expect(isValidProxyUrl("socks5://127.0.0.1:1080#frag")).toBe(false);
		// Other SOCKS variants are not supported.
		expect(isValidProxyUrl("socks4://127.0.0.1:1080")).toBe(false);
		expect(isValidProxyUrl("socks5h://127.0.0.1:1080")).toBe(false);
	});

	// ── Credential authentication + remote DNS ─────────────────────────────

	it("authenticates with separately stored SOCKS5 credentials and forwards the hostname as a domain through SOCKS", async () => {
		const fetch = await socksFetch(fixture);
		const response = await fetch(`${fixture.targetUrl}/v1/models`);
		try {
			expect(response.ok).toBe(true);
		} finally {
			await drain(response);
		}

		expect(fixture.connects).toHaveLength(1);
		const connect = fixture.connects[0]!;
		// The SOCKS5 server saw the real upstream credentials.
		expect(fixture.authAttempts).toHaveLength(1);
		expect(fixture.authAttempts[0]!.accepted).toBe(true);
		expect(fixture.authAttempts[0]!.username).toBe(SOCKS_USER);
		expect(fixture.authAttempts[0]!.password).toBe(SOCKS_PASS);
		// The target hostname reached the SOCKS5 server as a domain name
		// (ATYP=3), proving remote DNS — not resolved locally by Bun or the bridge.
		expect(connect.viaDomain).toBe(true);
		expect(connect.host).toBe(TARGET_HOST);
		expect(connect.port).toBe(fixture.targetPort);
	});

	// ── Gateway request traverses ──────────────────────────────────────────

	it("HTTPS gateway model-list request traverses the SOCKS5 bridge", async () => {
		const fetch = await socksFetch(fixture);
		const models = await listProviderModels({
			baseUrl: fixture.targetUrl,
			apiKey: "key",
			providerType: "openai",
			fetch,
		});
		expect(models).toHaveLength(1);
		expect(models[0]!.id).toBe("test-model");
		expect(fixture.connects).toHaveLength(1);
		expect(fixture.connects[0]!.host).toBe(TARGET_HOST);
	});

	// ── AI SDK non-streaming traverses ─────────────────────────────────────

	it("AI SDK non-streaming generation traverses the SOCKS5 bridge", async () => {
		const fetch = await socksFetch(fixture);
		const model = resolveModel(
			{ providerPreset: "openai", endpoint: fixture.targetUrl, apiKey: "key" },
			"test-model",
			undefined,
			fetch,
		);
		const result = await generateText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		expect(result.text).toBe("chat reply");
		expect(fixture.connects).toHaveLength(1);
	});

	// ── AI SDK streaming — first chunk arrives before the delayed second ────

	it("AI SDK streaming delivers the first chunk before a deliberately delayed later chunk", async () => {
		const fetch = await socksFetch(fixture);
		const model = resolveModel(
			{ providerPreset: "openai", endpoint: fixture.targetUrl, apiKey: "key" },
			"test-model",
			undefined,
			fetch,
		);
		const result = streamText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		// One explicit iterator: measure the first chunk's arrival, then drain
		// the SAME iterator. Iterating textStream twice (break then re-iterate)
		// would create a second iterator over an already-advanced stream.
		const iterator = result.textStream[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value.length).toBeGreaterThan(0);
		// The first chunk reached the client before the server produced the
		// second. A buffered response — the known failure mode — could only
		// deliver chunk one after the whole body was written, so this flag would
		// already be true. Ordering, not wall clock: a stalled runner cannot
		// turn it red.
		expect(secondChunkSent).toBe(false);

		// Drain the rest through the SAME iterator so the stream completes.
		let fullText = first.value;
		for (;;) {
			const { value, done } = await iterator.next();
			if (done) break;
			fullText += value;
		}
		expect(fullText).toContain("early");
		expect(fullText).toContain("delayed");
	});

	// ── AbortSignal propagation ────────────────────────────────────────────

	it("AbortSignal aborts an in-flight SOCKS5-proxied stream with an abort error", async () => {
		const fetch = await socksFetch(fixture);
		const controller = new AbortController();
		const response = await fetch(`${fixture.targetUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "test-model", messages: [], stream: true }),
			signal: controller.signal,
		});
		// Consume the stream, aborting after the first chunk. The read must
		// surface an AbortError (not just any network exception).
		const chunks: Uint8Array[] = [];
		let abortError: unknown;
		try {
			for await (const chunk of response.body!) {
				chunks.push(chunk);
				if (chunks.length === 1) controller.abort();
			}
		} catch (err) {
			abortError = err;
		}
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// The signal was definitively aborted...
		expect(controller.signal.aborted).toBe(true);
		// ...and the read failed with an abort-specific error, not a generic one.
		expect(abortError).toBeDefined();
		const errorName = abortError instanceof Error ? abortError.name : String(abortError);
		expect(/abort/i.test(errorName)).toBe(true);
	});

	// ── Wrong SOCKS5 credentials fail closed ───────────────────────────────

	it("wrong SOCKS5 credentials fail closed (no direct bypass)", async () => {
		const fetch = await socksFetch(fixture, "wrong-user", "wrong-pass");
		// Bun returns the proxy's error response (not a throw) on a CONNECT
		// failure — the request must NOT succeed via a silent direct bypass.
		const response = await fetch(`${fixture.targetUrl}/models`);
		try {
			expect(response.ok).toBe(false);
		} finally {
			await drain(response);
		}
		// The SOCKS5 fixture must have seen the auth attempt (and rejected it),
		// proving the request went through SOCKS rather than bypassing it.
		expect(fixture.authAttempts.length).toBeGreaterThanOrEqual(1);
		expect(fixture.authAttempts.every((a) => !a.accepted)).toBe(true);
	});

	// ── HTTPS-only: HTTP target rejected before fixture/target contact ─────

	it("rejects an HTTP target through a SOCKS5 proxy before any fixture or target contact", async () => {
		const fetch = await socksFetch(fixture);
		// The HTTP guard fires synchronously inside the wrapper — no fetch, no
		// DNS, no network. The SOCKS5 fixture must not have been contacted.
		expect(() => fetch(`http://${TARGET_HOST}:${fixture.targetPort}/v1/models`)).toThrow(ProviderProxyError);
		expect(fixture.connects).toHaveLength(0);
	});

	// ── Redirect escape: HTTPS→HTTP Location never followed ────────────────

	it("returns a 3xx redirect without following an HTTPS→HTTP Location through a SOCKS5 proxy", async () => {
		const fetch = await socksFetch(fixture);
		// The HTTPS provider endpoint returns a 302 whose Location is a loopback
		// plain-HTTP target. With redirect: "manual" (forced for SOCKS-backed
		// fetch), Bun must return the raw 3xx and never pursue the HTTP Location —
		// which would bypass both the HTTPS-only guard and the explicit proxy.
		const response = await fetch(`${fixture.targetUrl}/redirect-to-http`);
		try {
			// The response is returned without following the redirect: the raw 3xx
			// status is preserved and `redirected` is false.
			expect(response.status).toBeGreaterThanOrEqual(300);
			expect(response.status).toBeLessThan(400);
			expect(response.redirected).toBe(false);
			// The Location header still points at the loopback HTTP target, proving
			// the redirect was received but NOT followed.
			const location = response.headers.get("location");
			expect(location).not.toBeNull();
			expect(location!.startsWith("http://")).toBe(true);
			// The loopback HTTP redirect target was never contacted — tracked
			// explicitly, not inferred from an error.
			expect(fixture.httpTargetHits.count).toBe(0);
			// Exactly one SOCKS CONNECT — to the HTTPS provider target. A followed
			// redirect would have opened a second connection (to the HTTP target),
			// either through SOCKS or by bypassing the proxy for loopback.
			expect(fixture.connects).toHaveLength(1);
			expect(fixture.connects[0]!.host).toBe(TARGET_HOST);
			expect(fixture.connects[0]!.port).toBe(fixture.targetPort);
		} finally {
			await drain(response);
		}
	});

	// ── Direct bypass remains ──────────────────────────────────────────────

	it("direct mode bypasses the SOCKS5 bridge entirely", async () => {
		setProviderFetchFactory(createProviderFetchFactory(socksLookup(fixture.socksUrl), createTrustedFetch()));
		const providerFetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.direct, proxyId: null });
		expect(providerFetch).toBeUndefined();
		// Direct mode returns undefined (no proxy wrapper); the loopback HTTP
		// target is reached directly with no proxy and no environment changes.
		const models = await listProviderModels({
			baseUrl: fixture.httpTargetUrl,
			apiKey: "key",
			providerType: "openai",
		});
		expect(models).toHaveLength(1);
		expect(fixture.connects).toHaveLength(0);
	});

	// ── Credential-free error messages ─────────────────────────────────────

	it("error from a failed SOCKS5 connection contains no upstream credentials", async () => {
		const LEAK_PASSWORD = "socks-leak-canary-secret-value";
		// Use wrong credentials embedding a distinctive password; the upstream
		// URL carries this value — it must never surface in the response or error.
		const fetch = await socksFetch(fixture, "wrong-user", LEAK_PASSWORD);
		const response = await fetch(`${fixture.targetUrl}/models`);
		let body = "";
		try {
			expect(response.ok).toBe(false);
			body = await response.text();
		} finally {
			await drain(response);
		}
		// The response body (proxy error message) must not contain the upstream password.
		expect(body.includes(LEAK_PASSWORD)).toBe(false);
	});

	// ── Bridge caching: same config reuses one listener ────────────────────

	it("reuses a single bridge for the same upstream config across calls", async () => {
		const manager = getSocksBridgeManager();
		const fetch = await socksFetch(fixture);
		// Make one real request so the bridge is exercised end-to-end, then drain
		// it so the connection is released for deterministic teardown.
		const response = await fetch(`${fixture.targetUrl}/v1/models`);
		await drain(response);
		expect(manager.size).toBe(1);
		// A second resolution with the same upstream must NOT create a new bridge.
		await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "socks" });
		expect(manager.size).toBe(1);
	});

	// ── Bridge caching: a changed upstream config does NOT reuse a stale bridge ─

	it("creates a fresh bridge when the SOCKS5 upstream config changes", async () => {
		const manager = getSocksBridgeManager();
		// Config A — creates bridge #1.
		const fetchA = await socksFetch(fixture, SOCKS_USER, SOCKS_PASS);
		const responseA = await fetchA(`${fixture.targetUrl}/v1/models`);
		await drain(responseA);
		expect(manager.size).toBe(1);

		// Config B — different stored credentials produce a different effective
		// upstream URL → a different cache key → a fresh bridge, not a stale reuse.
		await socksFetch(fixture, "different-user", "different-pass");
		expect(manager.size).toBe(2);
	});
});

// ─── Bridge manager lifecycle (unit, no real network) ──────────────────────

/** A fake bridge handle that records whether it was force-closed. */
function fakeHandle(bridgeUrl: string): BridgeHandle & { closed: boolean; closeCalls: number } {
	const state = { closed: false, closeCalls: 0 };
	return {
		bridgeUrl,
		get closed() {
			return state.closed;
		},
		get closeCalls() {
			return state.closeCalls;
		},
		close: async () => {
			state.closeCalls += 1;
			state.closed = true;
		},
	};
}

describe("SOCKS5 bridge manager lifecycle", () => {
	it("deduplicates concurrent creations for the same upstream into one bridge", async () => {
		let creates = 0;
		const manager = createSocksBridgeManager({
			async createAndListen() {
				creates += 1;
				// Simulate creation latency so concurrent callers race.
				await new Promise((resolve) => setTimeout(resolve, 20));
				return fakeHandle(`http://bridge-${creates}`);
			},
		});
		const [a, b] = await Promise.all([
			manager.getOrCreateBridge("socks5://upstream:1080"),
			manager.getOrCreateBridge("socks5://upstream:1080"),
		]);
		expect(creates).toBe(1);
		expect(a).toBe(b);
		expect(manager.size).toBe(1);
		await manager.closeAll();
	});

	it("creates separate bridges for different upstreams", async () => {
		let creates = 0;
		const manager = createSocksBridgeManager({
			async createAndListen() {
				creates += 1;
				return fakeHandle(`http://bridge-${creates}`);
			},
		});
		const a = await manager.getOrCreateBridge("socks5://a:1080");
		const b = await manager.getOrCreateBridge("socks5://b:1080");
		expect(a).not.toBe(b);
		expect(creates).toBe(2);
		expect(manager.size).toBe(2);
		await manager.closeAll();
	});

	it("closes a bridge created during shutdown instead of orphaning it", async () => {
		const createdHandle = fakeHandle("http://created-during-close");
		let resolveListen: () => void = () => {};
		const listenGate = new Promise<void>((resolve) => {
			resolveListen = resolve;
		});
		const manager = createSocksBridgeManager({
			async createAndListen() {
				// Block creation until the test releases it, so closeAll runs
				// while a creation is genuinely in flight.
				await listenGate;
				return createdHandle;
			},
		});

		// Start a creation that blocks on the gate.
		const pending = manager.getOrCreateBridge("socks5://upstream:1080");
		// Begin shutdown while that creation is still in flight.
		const closePromise = manager.closeAll();
		// New acquisitions must be rejected once close has begun.
		await expect(manager.getOrCreateBridge("socks5://upstream:1080")).rejects.toThrow(
			/shutting down|closed/i,
		);
		// Let the in-flight creation finish: it must self-close (no orphan),
		// not insert into the map.
		resolveListen();
		await expect(pending).rejects.toThrow(/closed during/i);
		await closePromise;

		expect(createdHandle.closed).toBe(true);
		expect(createdHandle.closeCalls).toBe(1);
		expect(manager.size).toBe(0);
	});

	it("rejects new acquisitions after closeAll and is a no-op when empty", async () => {
		let creates = 0;
		const manager = createSocksBridgeManager({
			async createAndListen() {
				creates += 1;
				return fakeHandle(`http://bridge-${creates}`);
			},
		});
		// Closing an empty manager succeeds and does not throw.
		await manager.closeAll();
		expect(manager.size).toBe(0);
		// Every subsequent acquisition is rejected (manager is permanently closing).
		await expect(manager.getOrCreateBridge("socks5://upstream:1080")).rejects.toThrow();
		expect(creates).toBe(0);
	});

	it("force-closes every bridge on closeAll and aggregates failures generically", async () => {
		const ok = fakeHandle("http://ok");
		const failing: BridgeHandle = {
			bridgeUrl: "http://failing",
			close: async () => {
				throw new Error("boom");
			},
		};
		let nth = 0;
		const manager = createSocksBridgeManager({
			async createAndListen() {
				nth += 1;
				// First bridge closes cleanly; second throws — proving closeAll still
				// attempts both and surfaces a single generic error.
				return nth === 1 ? ok : failing;
			},
		});
		await manager.getOrCreateBridge("socks5://a:1080");
		await manager.getOrCreateBridge("socks5://b:1080");
		expect(manager.size).toBe(2);

		await expect(manager.closeAll()).rejects.toThrow(/failure/i);
		expect(ok.closed).toBe(true);
		expect(manager.size).toBe(0);
	});
});
