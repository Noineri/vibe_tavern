/**
 * @module model-mirror/hf-repo-sizes
 *
 * Shared size oracle for the model mirrors (P14, post-plan audit). The
 * in-browser runtimes (transformers.js for Whisper, kokoro-js for Kokoro)
 * compute download progress as loaded/total where `total` starts at 0 and
 * stretches to each chunk read whenever the response carries no
 * Content-Length — the HF→CDN redirect hop through the proxy delivers
 * exactly that way, so the download bar pins at 100% from the first chunk.
 * When a mirror's upstream response arrives WITHOUT a Content-Length, the
 * mirrors resolve the true byte size from the HF repo tree API and inject
 * it into the response headers themselves.
 *
 * Verified live (2026-09-05, onnx-community/Kokoro-82M-v1.0-ONNX): the
 * tree endpoint `?recursive=true` returns nested paths in one response,
 * roster-scale repos fit a single page (70 entries, no pagination Link
 * header), and the top-level `size` on a file entry is the REAL file size —
 * for LFS-backed files it equals `lfs.size` (not the ~134-byte pointer),
 * which is exactly what Content-Length must carry.
 *
 * Fail-soft by design: a lookup that errors, returns non-200/non-JSON, or
 * does not contain the path yields null and the mirror answers exactly as
 * it did before P14 (no Content-Length, download still streams). Failed
 * listings are never cached — the next length-less request retries. A
 * successful listing is cached for the process lifetime: the mirrors serve
 * a fixed roster of repos whose files are immutable in practice; a stale
 * entry would surface as a mismatched stream length, never as an error.
 */

import { PROXY_MODE } from "@vibe-tavern/domain";

import { getProviderFetchFactory, type ProviderFetch } from "../providers/provider-fetch-factory.js";

/** Tree API base — `<base><repo>/tree/main?recursive=true`. */
const HF_TREE_BASE = "https://huggingface.co/api/models/";

/** Deps kept injectable for deterministic tests (same seam as the mirrors). */
export interface HfRepoSizeDeps {
	/** Transport used for the tree listing (defaults to the proxy-aware
	 *  factory resolution — inherit = the app's global default proxy, or
	 *  plain fetch when none is configured). */
	resolveFetch?: () => Promise<ProviderFetch>;
}

/** One untrusted tree entry as it comes off the wire. */
interface HfTreeEntry {
	type?: unknown;
	path?: unknown;
	size?: unknown;
}

export class HfRepoSizeCache {
	private readonly deps: HfRepoSizeDeps;
	/** Single-flight per repo: concurrent length-less requests for one repo
	 *  share a single listing fetch. */
	private readonly listings = new Map<string, Promise<Map<string, number>>>();

	constructor(deps?: HfRepoSizeDeps) {
		this.deps = deps ?? {};
	}

	/** True byte size of `repoPath` inside `repo`, or null when unknown. */
	async fileSize(repo: string, repoPath: string): Promise<number | null> {
		const listing = await this.listingFor(repo);
		return listing.get(repoPath) ?? null;
	}

	private listingFor(repo: string): Promise<Map<string, number>> {
		const existing = this.listings.get(repo);
		if (existing) return existing;
		const promise = this.fetchListing(repo).catch(() => {
			// Fail-soft AND retryable: callers get an empty listing, and the
			// failed attempt is dropped so the next request re-fetches.
			this.listings.delete(repo);
			return new Map<string, number>();
		});
		this.listings.set(repo, promise);
		return promise;
	}

	private async fetchListing(repo: string): Promise<Map<string, number>> {
		const fetchFn = await this.resolveFetch();
		const response = await fetchFn(`${HF_TREE_BASE}${repo}/tree/main?recursive=true`);
		if (!response.ok) return new Map<string, number>();
		const payload: unknown = await response.json().catch(() => null);
		const out = new Map<string, number>();
		if (!Array.isArray(payload)) return out;
		for (const entry of payload as HfTreeEntry[]) {
			if (entry?.type !== "file" || typeof entry.path !== "string") continue;
			// Live-verified: top-level `size` is the real file size (== lfs.size
			// for LFS entries) — the pointer size lives in lfs.pointerSize.
			if (typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0) {
				out.set(entry.path, entry.size);
			}
		}
		return out;
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
}
