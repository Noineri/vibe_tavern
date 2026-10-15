import type { ImageGenProfileValue } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";

import { findImageGenAutoKeyProvider } from "./image-gen-auto-key.js";

/** Auto-key HINT (UI display only, IG-21 — the stt-adapter twin): which
 *  provider profile's key auto-matches for a keyless profile. Runs the SAME
 *  matcher as the execution seam (`findImageGenAutoKeyProvider`,
 *  image-gen-auto-key.ts — host rule, first keyful provider in list order,
 *  every key-taking backend; a1111/comfyui never), so the named provider is
 *  always the one whose key generation will use. Records with a stored key
 *  stay null — an own key overrides. */
export async function decorateImageGenProfileAutoKeys(
  stores: Pick<StoreContainer, "providers">,
  records: ImageGenProfileValue[],
): Promise<ImageGenProfileValue[]> {
  if (records.length === 0) return records;
  const providers = await stores.providers.listAll();
  if (!providers.some((provider) => provider.apiKey)) return records;
  for (const record of records) {
    if (record.hasStoredApiKey) continue;
    record.autoKeyProviderName = findImageGenAutoKeyProvider(providers, record.backend, record.endpoint)?.name ?? null;
  }
  return records;
}
