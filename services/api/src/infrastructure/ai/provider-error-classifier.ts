/**
 * Classifies an arbitrary error thrown during provider request execution into a
 * {@link ProviderErrorCategory}. Pure, no I/O, no `ai` package import — the AI
 * SDK error shapes (`APICallError`, `RetryError`) are duck-typed, mirroring the
 * approach in `provider-error-message.ts` so the two modules stay testable in
 * isolation and free of runtime SDK coupling.
 *
 * This is Layer 1 of the provider-error-categorization reanimation. It makes
 * the dormant `ProviderErrorCategory` union reachable; layers 2–4 (throw sites
 * in the execution boundary, SSE wire field, UI surfacing) build on top of it.
 * See `vibe_tavern_plan/reports/provider-error-categorization-reanimation.md`.
 *
 * Resolution order matters: RetryError is unwrapped first (its `lastError`
 * carries the real APICallError), DomainError short-circuits on the VT-side
 * kinds it already encodes, and the AI SDK status-code mapping is the workhorse.
 * Fall-throughs are deliberately conservative — `unknown` rather than a guess.
 */

import { ProviderExecutionError } from "./provider-execution-types.js";
import type { ProviderErrorCategory } from "./provider-execution-types.js";
import { isDomainError } from "../../shared/errors.js";

// ─── duck-typed AI SDK error shapes (no `ai` import) ───────────────────────

interface ApiCallErrorLike {
  statusCode?: number;
  isRetryable?: boolean;
  data?: unknown;
  responseBody?: string;
  url?: string;
  responseHeaders?: unknown;
  cause?: unknown;
}

interface RetryErrorLike {
  errors: unknown[];
  lastError?: unknown;
  reason?: string;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRetryError(error: unknown): RetryErrorLike | null {
  if (!isRecord(error)) return null;
  const errors = error.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return { errors, lastError: error.lastError, reason: typeof error.reason === "string" ? error.reason : undefined };
}

function asApiCallError(error: unknown): ApiCallErrorLike | null {
  if (!isRecord(error)) return null;
  // APICallError carries statusCode as a number; presence of other SDK fields
  // strengthens the match but statusCode alone is sufficient and is what the
  // status-mapping below keys off.
  if (typeof error.statusCode !== "number") return null;
  return {
    statusCode: error.statusCode,
    isRetryable: typeof error.isRetryable === "boolean" ? error.isRetryable : undefined,
    data: error.data,
    responseBody: typeof error.responseBody === "string" ? error.responseBody : undefined,
    url: typeof error.url === "string" ? error.url : undefined,
    responseHeaders: error.responseHeaders,
    cause: error.cause,
  };
}

const NETWORK_ERRNOS = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

const NETWORK_MESSAGE_RE = /fetch failed|getaddrinfo|socket hang up|write ECONN|network error|internet connection/i;

function isNetworkError(error: unknown): boolean {
  // Node system errors surface as `Error` with a `code` property (ENOTFOUND, …).
  // AI SDK wraps these as APICallError with statusCode undefined and the native
  // error in `cause`; `fetch failed` appears verbatim in the message.
  const rec = isRecord(error) ? error : null;
  if (rec) {
    const code = typeof rec.code === "string" ? rec.code : undefined;
    if (code && NETWORK_ERRNOS.has(code)) return true;
    const causeCode = isRecord(rec.cause) && typeof rec.cause.code === "string" ? rec.cause.code : undefined;
    if (causeCode && NETWORK_ERRNOS.has(causeCode)) return true;
  }
  if (error instanceof Error && NETWORK_MESSAGE_RE.test(error.message)) return true;
  if (typeof error === "string" && NETWORK_MESSAGE_RE.test(error)) return true;
  return false;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    // Bare `{ name: 'AbortError' }` objects from some SDK paths.
    return isRecord(error) && error.name === "AbortError";
  }
  if (error.name === "AbortError") return true;
  // Playwright/Node DOMException for an aborted signal.
  if (error.name === "DOMException" && /abort/i.test(error.message)) return true;
  if ((error as Error & { code?: string }).code === "ABORT_ERR") return true;
  return false;
}

function isNoOutputGenerated(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "NoOutputGeneratedError") return true;
  if (typeof error.message === "string" && /no output generated/i.test(error.message)) return true;
  return false;
}

function isParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (isRecord(error)) {
    if (error.name === "JSONParseError" || error.name === "TypeValidationError") return true;
    if (typeof error.message === "string" && /unexpected token|invalid json|json parse|unexpected end of json/i.test(error.message)) return true;
  }
  return false;
}

function classifyByStatus(statusCode: number): ProviderErrorCategory | null {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  if (statusCode === 400 || statusCode === 422) return "invalid_request";
  if (statusCode >= 500 && statusCode < 600) return "server_error";
  return null;
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Map an error raised by the provider execution layer to a stable category.
 *
 * Unwraps AI SDK `RetryError` (to its `lastError`) and recognizes VT
 * `DomainError` short-circuits, then falls through to status-code and
 * network/abort heuristics. Returns `"unknown"` when no signal matches rather
 * than guessing — callers should treat `unknown` as "show the raw message".
 */
export function classifyProviderError(error: unknown): ProviderErrorCategory {
  // 0. ProviderExecutionError — already classified at the execution boundary;
  //    respect it instead of re-deriving. This matters because the class also
  //    carries a `statusCode`, which asApiCallError would duck-type and could
  //    map to a *different* category than the one the boundary chose (e.g. an
  //    aborted request that happens to surface a 504). Short-circuiting keeps
  //    the two paths consistent.
  if (error instanceof ProviderExecutionError) return error.category;

  // 1. VT DomainError — already typed on our side.
  if (isDomainError(error)) {
    switch (error.kind) {
      case "Cancelled":
        return "aborted";
      case "Unauthorized":
        return "authentication";
      // Provider / Internal / Validation / Conflict / NotFound — the original
      // cause is not preserved on DomainError, so we cannot classify further.
      default:
        return "unknown";
    }
  }

  // 2. AI SDK RetryError — unwrap to the last attempt, or honor an abort reason.
  const retry = asRetryError(error);
  if (retry) {
    if (retry.reason === "abort") return "aborted";
    const inner = retry.lastError ?? retry.errors[retry.errors.length - 1];
    return classifyProviderError(inner);
  }

  // 3. Explicit abort (signal aborted mid-request, no retry wrapper).
  if (isAbortError(error)) return "aborted";

  // 4. Empty generation — AI SDK NoOutputGeneratedError.
  if (isNoOutputGenerated(error)) return "empty_response";

  // 5. APICallError — the primary signal, keyed off statusCode.
  const apiLike = asApiCallError(error);
  if (apiLike) {
    const byStatus = apiLike.statusCode !== undefined ? classifyByStatus(apiLike.statusCode) : null;
    if (byStatus) return byStatus;
    // statusCode present but outside the mapped ranges, and no network/parse
    // signature — fall through to heuristics, then unknown.
  }

  // 6. Network / parse heuristics (apply to both the error itself and, for
  // APICallError, the underlying cause where Node errno lives).
  const probeTarget = apiLike?.cause ?? error;
  if (isNetworkError(probeTarget) || isNetworkError(error)) return "network";
  if (isParseError(error) || isParseError(apiLike?.cause)) return "parse_error";

  return "unknown";
}

/**
 * Extract the HTTP status code carried by an AI SDK / provider error, if any.
 * Unwraps RetryError first (mirroring {@link classifyProviderError}) so the
 * status of the real underlying APICallError is returned, not the wrapper's.
 * Companion to `classifyProviderError`; kept here so all duck-typing of SDK
 * error shapes lives in one module.
 */
export function extractProviderErrorStatusCode(error: unknown): number | undefined {
  const retry = asRetryError(error);
  if (retry) {
    const inner = retry.lastError ?? retry.errors[retry.errors.length - 1];
    return extractProviderErrorStatusCode(inner);
  }
  return asApiCallError(error)?.statusCode;
}
