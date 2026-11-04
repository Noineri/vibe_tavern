import { redactEndpointForDiagnostics } from "./diagnostics-builder.js";

/**
 * SM-9a consent-scoped generation diagnostics (owner 2026-11-04): technical
 * diagnostics stay content-free by default, and ONE explicitly selected
 * problematic generation may be attached after a separate confirmation.
 *
 * This module projects a SINGLE stored trace into zip entries — its assembled
 * request (`finalPayload`), its captured provider response, and identifying
 * technical metadata. It never reads the chat itself, never re-assembles a
 * prompt from current settings, and never falls back to another trace: the
 * caller resolves the exact stored row first; missing captures are reported,
 * not substituted.
 *
 * Credentials are removed HERE, before anything is returned for preview or
 * serialization — permission to attach content is not permission to attach
 * credentials (plan constraint, both modes). The user-approved prose itself
 * survives: redaction only removes credential SHAPES (structured fields,
 * credential-bearing URLs, configured secret literals), not content.
 */

/** The generation a diagnostics export refers to — every identity field must
 * match the stored trace exactly. The full tuple (not just the trace id) is
 * sent BY the client on both preview and download, so a stale or tampered
 * selection is rejected instead of silently resolving to whatever now sits
 * under that id. */
export interface DiagnosticsGenerationSelection {
  traceId: string;
  chatId: string;
  branchId: string;
  messageId: string;
  variantId: string | null;
}

/** A redacted, ready-to-serialize file of the content-bearing archive. */
export interface GenerationDiagnosticsFile {
  path: string;
  text: string;
}

export interface GenerationDiagnosticsResult {
  files: GenerationDiagnosticsFile[];
  /** Captured-but-absent fields (e.g. "providerResponse" on a failed attempt
   * whose response was never captured) — surfaced honestly in the preview
   * instead of being papered over. */
  missing: string[];
}

/** The stored-trace shape this module projects — a structural subset of the
 * db-layer's PromptTrace. `domain` cannot import from `@vibe-tavern/db`
 * (the dependency graph points the other way), so the fields are restated
 * here and the store type satisfies them structurally. */
export interface GenerationDiagnosticsTrace {
  id: string;
  chatId: string;
  branchId: string;
  messageId: string;
  variantId: string | null;
  model: string;
  presetName: string;
  createdAt: string;
  latencyMs: number;
  tokenAccounting: Record<string, number>;
  finalPayload: Record<string, unknown>;
  sentConfig?: unknown;
  providerResponse?: unknown;
  prefill?: string | null;
  compactionSummary?: string | null;
}

/** True iff the stored trace IS the selected attempt — all five identity
 * fields compared; any drift (wrong swipe, wrong message, regenerated trace)
 * is a mismatch. */
export function matchesGenerationSelection(
  trace: GenerationDiagnosticsTrace,
  selection: DiagnosticsGenerationSelection,
): boolean {
  return (
    trace.id === selection.traceId &&
    trace.chatId === selection.chatId &&
    trace.branchId === selection.branchId &&
    trace.messageId === selection.messageId &&
    trace.variantId === selection.variantId
  );
}

// ── Credential redaction ─────────────────────────────────────────────────────

const REDACTED = "[redacted]";

/** Key names whose VALUE is a credential wherever the shape appears — matched
 * on a normalized form (lowercased, non-alphanumerics stripped) so `api_key`,
 * `apiKey`, `X-Api-Key` and `x-api-key` all hit. Exact-match only:
 * `tokenCount`/`max_tokens` normalize to different strings and stay visible. */
const CREDENTIAL_KEY_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "xapikey",
  "accesstoken",
  "authtoken",
  "refreshtoken",
  "sessiontoken",
  "token",
  "password",
  "clientsecret",
  "secret",
  "bearer",
]);

function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_NAMES.has(normalizeCredentialKey(key));
}

/** Absolute URLs inside captured strings, for structural URL redaction.
 * Delimiters that commonly hug a URL in prose/log text end the match. */
const ABSOLUTE_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
/** Trailing prose punctuation that is not part of the address — peeled off
 * before parsing so "…see https://h.ex/v1." redacts the URL, not the period. */
const URL_TAIL_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function redactUrlsInString(value: string): string {
  return value.replace(ABSOLUTE_URL_PATTERN, (matched) => {
    const withoutTail = matched.replace(URL_TAIL_PUNCTUATION, "");
    const tail = matched.slice(withoutTail.length);
    // An unparseable match (a URL cut mid-flight in prose) still degrades to
    // the explicit placeholder — a partial address must not ship verbatim,
    // because the cut part is unknowable.
    return `${redactEndpointForDiagnostics(withoutTail)}${tail}`;
  });
}

/** Configured secrets shorter than this are skipped as literals — a 2–3 char
 * "secret" would carpet-replace ordinary prose. Structured/URL redaction
 * still applies to those. */
const MIN_SECRET_LITERAL_LENGTH = 6;

function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LITERAL_LENGTH) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Deep credential redaction over a captured JSON value: credential-shaped
 * KEYS lose their values, strings lose URL userinfo/query/fragments and any
 * configured secret literal echoed inside them. Everything else — the prose
 * the user consented to attach — passes through untouched. */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactKnownSecrets(redactUrlsInString(value), secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isCredentialKey(key) ? REDACTED : redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

// ── Entry projection ─────────────────────────────────────────────────────────

function jsonFile(path: string, value: unknown): GenerationDiagnosticsFile {
  return { path, text: `${JSON.stringify(value, null, 2)}\n` };
}

/**
 * Project ONE stored generation into the optional `generation/` entries of a
 * diagnostics export. Entries are separate and clearly named, and only the
 * actually captured fields produce files:
 *
 * - `generation/request.json`   — the exact assembled payload sent (absent
 *                                 when nothing was captured).
 * - `generation/response.json`  — the captured provider response, which on a
 *                                 defective attempt may itself BE the recorded
 *                                 error body (absent when never captured).
 * - `generation/metadata.json`  — always present: identity, model, effective
 *                                 generation parameters (`sentConfig`), token
 *                                 accounting and a capture report.
 */
export function buildGenerationDiagnostics(
  trace: GenerationDiagnosticsTrace,
  knownSecrets: readonly string[],
): GenerationDiagnosticsResult {
  const missing: string[] = [];
  const files: GenerationDiagnosticsFile[] = [];

  const requestCaptured =
    trace.finalPayload !== null &&
    typeof trace.finalPayload === "object" &&
    Object.keys(trace.finalPayload).length > 0;
  if (requestCaptured) {
    files.push(jsonFile("generation/request.json", redactValue(trace.finalPayload, knownSecrets)));
  } else {
    missing.push("finalPayload");
  }

  const responseCaptured = trace.providerResponse !== null && trace.providerResponse !== undefined;
  if (responseCaptured) {
    files.push(jsonFile("generation/response.json", redactValue(trace.providerResponse, knownSecrets)));
  } else {
    missing.push("providerResponse");
  }

  // Metadata goes through the same redactor as the captured payloads — an
  // echoed secret must not survive anywhere, whatever field it landed in.
  files.push(
    jsonFile("generation/metadata.json", redactValue({
      traceId: trace.id,
      chatId: trace.chatId,
      branchId: trace.branchId,
      messageId: trace.messageId,
      variantId: trace.variantId,
      model: trace.model,
      presetName: trace.presetName,
      createdAt: trace.createdAt,
      latencyMs: trace.latencyMs,
      tokenAccounting: trace.tokenAccounting,
      sentConfig: trace.sentConfig ?? null,
      prefill: trace.prefill ?? null,
      compactionSummary: trace.compactionSummary ?? null,
      capture: { request: requestCaptured, response: responseCaptured },
    }, knownSecrets)),
  );

  return { files, missing };
}
