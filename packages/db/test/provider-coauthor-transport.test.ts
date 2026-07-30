import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import { ProviderStore } from "../src/stores/provider-store.js";

describe("ProviderStore Co-Author transport", () => {
  test("defaults existing-style creates to Chat Completions and persists updates and duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-coauthor-transport-"));
    const db = await createDb(join(dir, "test.db"));
    const store = new ProviderStore(db);

    const created = await store.create({ name: "OpenAI", providerPreset: "openai", endpoint: "https://api.openai.com/v1" });
    expect(created.coauthorTransport).toBe(COAUTHOR_TRANSPORT.chatCompletions);

    const updated = await store.update(created.id, { coauthorTransport: COAUTHOR_TRANSPORT.responses });
    expect(updated.coauthorTransport).toBe(COAUTHOR_TRANSPORT.responses);
    expect((await store.getById(created.id))?.coauthorTransport).toBe(COAUTHOR_TRANSPORT.responses);

    const duplicate = await store.duplicate(created.id);
    expect(duplicate.coauthorTransport).toBe(COAUTHOR_TRANSPORT.responses);
  });
});
