function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractFromErrorData(error: unknown): string | null {
  if (!isRecord(error)) return null;

  const data = error.data;
  if (isRecord(data)) {
    const dataError = data.error;
    if (isRecord(dataError) && typeof dataError.message === "string") return dataError.message;
    if (typeof data.message === "string") return data.message;
  }

  const responseBody = error.responseBody;
  if (typeof responseBody === "string") {
    const parsed = parseJsonRecord(responseBody);
    const parsedError = parsed?.error;
    if (isRecord(parsedError) && typeof parsedError.message === "string") return parsedError.message;
    if (typeof parsed?.message === "string") return parsed.message;
  }

  return null;
}

function stripWrapperPrefixes(message: string): string {
  return message
    .replace(/^Provider stream error:\s*/i, "")
    .replace(/^Failed after \d+ attempts\. Last error:\s*/i, "")
    .trim();
}

/**
 * Extracts a user-facing provider error message from AI SDK errors.
 * Handles RetryError -> last APICallError, APICallError.data/responseBody,
 * and our DomainError wrapper messages.
 */
export function extractProviderErrorMessage(error: unknown, fallback = "Provider request failed"): string {
  if (isRecord(error) && Array.isArray(error.errors) && error.errors.length > 0) {
    return extractProviderErrorMessage(error.errors[error.errors.length - 1], fallback);
  }

  const dataMessage = extractFromErrorData(error);
  if (dataMessage) return dataMessage;

  if (error instanceof Error && error.message) {
    return stripWrapperPrefixes(error.message);
  }

  if (typeof error === "string" && error.trim()) {
    return stripWrapperPrefixes(error);
  }

  return fallback;
}
