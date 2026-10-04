import type { ImageGenProfileValue } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

const OPENROUTER_API_HOST = "https://openrouter.ai";

function normalizeEndpoint(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "").toLowerCase();
}

/** Auto-key HINT (UI display only, IG-21 — the stt-adapter twin): which
 *  provider profile's key auto-matches for a keyless profile. The SAME
 *  rule as autoMatchImageGenKey (first keyful provider in sort order;
 *  openrouter by vendor host, openai-images by exact endpoint, a1111
 *  never). Records with a stored key stay null — an own key overrides. */
export async function decorateImageGenProfileAutoKeys(
  stores: Pick<StoreContainer, "providers">,
  records: ImageGenProfileValue[],
): Promise<ImageGenProfileValue[]> {
  if (records.length === 0) return records;
  const providers = await stores.providers.listAll();
  const keyful = providers.filter((provider) => provider.apiKey);
  if (keyful.length === 0) return records;
  const byEndpoint = new Map(keyful.map((provider) => [normalizeEndpoint(provider.endpoint), provider.name]));
  const openrouterName = keyful.find((provider) =>
    normalizeEndpoint(provider.endpoint).startsWith(OPENROUTER_API_HOST),
  )?.name;
  for (const record of records) {
    if (record.hasStoredApiKey) continue;
    if (record.backend === IMAGE_GEN_BACKENDS.OpenRouter) {
      record.autoKeyProviderName = openrouterName ?? null;
    } else if (record.backend === IMAGE_GEN_BACKENDS.OpenAiImages) {
      const endpoint = record.endpoint.trim();
      if (endpoint === "") continue;
      record.autoKeyProviderName = byEndpoint.get(normalizeEndpoint(endpoint)) ?? null;
    }
  }
  return records;
}
