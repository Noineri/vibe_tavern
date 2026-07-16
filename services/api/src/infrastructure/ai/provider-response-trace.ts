import type { ProviderResponseStep, ProviderResponseTrace, TraceJsonValue } from "@vibe-tavern/domain";

const SENSITIVE_RESPONSE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
]);

const SENSITIVE_HEADER_FRAGMENTS = [
  "api-key",
  "auth-token",
  "access-token",
  "security-token",
  "session-token",
  "secret-key",
  "private-key",
];

export interface ProviderResponseStepInput {
  response?: {
    id?: string;
    timestamp?: Date | string;
    modelId?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  providerMetadata?: unknown;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

function isSensitiveResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll("_", "-");
  if (SENSITIVE_RESPONSE_HEADERS.has(normalized)) return true;
  if (normalized.split("-").some((segment) => segment === "token" || segment === "password" || segment === "secret")) return true;
  return SENSITIVE_HEADER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Preserve diagnostic/rate-limit headers while excluding recognized credential-bearing values. */
export function sanitizeResponseHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveResponseHeader(name)),
  );
}

/**
 * Convert arbitrary provider values into a stable JSON representation.
 * Plain JSON values are preserved; unsupported JS values receive explicit
 * string/type markers instead of throwing or disappearing during stringify.
 */
export function toTraceJsonValue(value: unknown, ancestors = new WeakSet<object>()): TraceJsonValue {
  try {
    return convertTraceJsonValue(value, ancestors);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Unserializable: ${message}]`;
  }
}

function convertTraceJsonValue(value: unknown, ancestors: WeakSet<object>): TraceJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return `[Symbol(${value.description ?? ""})]`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;

  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      };
    }
    if (Array.isArray(value)) {
      return Array.from(value, (item) => toTraceJsonValue(item, ancestors));
    }
    if (value instanceof Map) {
      return {
        $type: "Map",
        entries: Array.from(value.entries(), ([key, item]) => [
          toTraceJsonValue(key, ancestors),
          toTraceJsonValue(item, ancestors),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        $type: "Set",
        values: Array.from(value.values(), (item) => toTraceJsonValue(item, ancestors)),
      };
    }
    if (value instanceof ArrayBuffer) {
      return { $type: "ArrayBuffer", bytes: Array.from(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        $type: value.constructor.name,
        bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    }

    const record: Record<string, TraceJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      const jsonKey = typeof key === "symbol" ? `[symbol:${key.description ?? ""}]` : key;
      const converted = "value" in descriptor
        ? toTraceJsonValue(descriptor.value, ancestors)
        : "[Accessor]";
      Object.defineProperty(record, jsonKey, {
        value: converted,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return record;
  } finally {
    ancestors.delete(value);
  }
}

/** Convert AI SDK response metadata into the JSON-safe domain trace shape. */
export function serializeProviderResponseStep(
  step: ProviderResponseStepInput,
  rawChunks?: unknown[],
): ProviderResponseStep {
  const response = step.response;
  const headers = sanitizeResponseHeaders(response?.headers);
  const serializedResponse = response
    ? {
        ...(response.id !== undefined ? { id: response.id } : {}),
        ...(response.timestamp !== undefined
          ? { timestamp: response.timestamp instanceof Date ? response.timestamp.toISOString() : response.timestamp }
          : {}),
        ...(response.modelId !== undefined ? { modelId: response.modelId } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(response.body !== undefined ? { body: toTraceJsonValue(response.body) } : {}),
      }
    : undefined;

  return {
    ...(serializedResponse ? { response: serializedResponse } : {}),
    ...(step.providerMetadata !== undefined ? { providerMetadata: toTraceJsonValue(step.providerMetadata) } : {}),
    ...(step.finishReason !== undefined ? { finishReason: step.finishReason } : {}),
    ...(step.rawFinishReason !== undefined ? { rawFinishReason: step.rawFinishReason } : {}),
    ...(step.usage !== undefined
      ? {
          usage: {
            ...(step.usage.inputTokens !== undefined ? { inputTokens: step.usage.inputTokens } : {}),
            ...(step.usage.outputTokens !== undefined ? { outputTokens: step.usage.outputTokens } : {}),
            ...(step.usage.totalTokens !== undefined ? { totalTokens: step.usage.totalTokens } : {}),
          },
        }
      : {}),
    ...(rawChunks !== undefined ? { rawChunks: rawChunks.map((chunk) => toTraceJsonValue(chunk)) } : {}),
  };
}

export function serializeProviderResponseTrace(
  mode: ProviderResponseTrace["mode"],
  steps: ProviderResponseStepInput[],
): ProviderResponseTrace {
  return {
    mode,
    steps: steps.map((step) => serializeProviderResponseStep(step)),
  };
}
