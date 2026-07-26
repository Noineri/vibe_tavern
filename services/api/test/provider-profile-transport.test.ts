import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { createDb, ProviderStore } from "@vibe-tavern/db";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), "vt-provider-transport-service-"));
  const db = await createDb(join(dir, "test.db"));
  return createProviderProfileService(new ProviderStore(db));
}

describe("provider profile Co-Author transport validation", () => {
  test("defaults new profiles and returns the transport in the client DTO", async () => {
    const service = await makeService();
    const profile = await service.saveProviderProfile({ name: "Default", providerPreset: "deepseek", endpoint: "https://api.deepseek.com" });
    expect(profile.coauthorTransport).toBe(COAUTHOR_TRANSPORT.chatCompletions);
  });

  test("permits explicit Responses attempts for every OpenAI-compatible preset but rejects native transports", async () => {
    const service = await makeService();
    const supported = await service.saveProviderProfile({ name: "OpenAI", providerPreset: "openai", endpoint: "https://api.openai.com/v1", coauthorTransport: COAUTHOR_TRANSPORT.responses });
    expect(supported.coauthorTransport).toBe(COAUTHOR_TRANSPORT.responses);

    const customCompatible = await service.saveProviderProfile({ name: "DeepSeek", providerPreset: "deepseek", endpoint: "https://api.deepseek.com", coauthorTransport: COAUTHOR_TRANSPORT.responses });
    expect(customCompatible.coauthorTransport).toBe(COAUTHOR_TRANSPORT.responses);

    await expect(service.updateProviderProfile(supported.id, { providerPreset: "google" })).rejects.toMatchObject({ kind: "Validation" });
  });
});
