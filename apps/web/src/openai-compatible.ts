export interface OpenAiModelOption {
  id: string;
  label: string;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  if (normalized.endsWith("/chat/completions")) {
    return normalized.slice(0, -"/chat/completions".length);
  }

  return normalized;
}
