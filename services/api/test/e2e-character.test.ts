/**
 * Test — Character CRUD with all fields
 *
 * Covers:
 *   1. Create character with all v3 fields via POST /api/characters
 *   2. Verify round-trip of every field (personalitySummary, depthPrompt, tags, etc.)
 *   3. Update character via PATCH /api/characters/:id — all fields
 *   4. Verify updated values round-trip correctly
 *
 * No network calls — only local DB + session runtime.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { createTestServer, json } from "./helpers/e2e-server.js";
import type { TestServer } from "./helpers/e2e-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  if (server) await server.cleanup();
});

// ─── Types ─────────────────────────────────────────────────────────────────

interface Snapshot {
  character: CharacterSnapshot;
}

interface ImportResult {
  activeChatId: string;
  snapshot: Snapshot;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Character CRUD — all fields", () => {
  let characterId: string;

  const FULL_CREATE = {
    name: "Aria",
    description: "A wandering swordswoman from the northern highlands.",
    personalitySummary: "Stoic, honourable, dry wit, secretly loves cute things.",
    firstMessage: "*A cloaked figure steps from the treeline, blade still sheathed.* You shouldn't be on this road after dark.",
    scenario: "A fog-shrouded mountain pass at dusk.",
    mesExample: "<START>\n{{user}}: Who are you?\n{{char}}: *She pulls back her hood.* Aria. Just Aria.",
    alternateGreetings: ["*Aria is already sitting by the fire when you arrive.*"],
    postHistoryInstructions: "[Respond in third person. Keep responses to 3-4 paragraphs.]",
    creatorNotes: "Designed for fantasy adventure RP.",
    systemPrompt: "You are Aria, a wandering swordswoman.",
    depthPrompt: "Aria keeps her hand near her sword hilt.",
    depthPromptDepth: 4,
    depthPromptRole: "system",
    tags: ["fantasy", "OC", "SFW"],
  };

  it("creates a character with all v3 fields", async () => {
    const result = await json<ImportResult>(
      await server.api("/api/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FULL_CREATE),
      }),
    );

    const c = result.snapshot.character;
    characterId = c.id;

    // Core fields
    expect(c.name).toBe("Aria");
    expect(c.description).toBe("A wandering swordswoman from the northern highlands.");
    expect(c.personalitySummary).toBe("Stoic, honourable, dry wit, secretly loves cute things.");
    expect(c.firstMessage).toContain("cloaked figure");
    expect(c.scenario).toBe("A fog-shrouded mountain pass at dusk.");

    // Example dialogue
    expect(c.mesExample).toContain("{{user}}");

    // Alternate greetings
    expect(c.alternateGreetings).toHaveLength(1);
    expect(c.alternateGreetings[0]).toContain("fire");

    // Advanced v3 fields
    expect(c.postHistoryInstructions).toContain("third person");
    expect(c.creatorNotes).toBe("Designed for fantasy adventure RP.");
    expect(c.systemPrompt).toBe("You are Aria, a wandering swordswoman.");
    expect(c.depthPrompt).toBe("Aria keeps her hand near her sword hilt.");
    expect(c.depthPromptDepth).toBe(4);
    expect(c.depthPromptRole).toBe("system");

    // Tags
    expect(c.tags).toEqual(["fantasy", "OC", "SFW"]);
  });

  it("updates all fields via PATCH and round-trips correctly", async () => {
    const PATCH = {
      name: "Aria Stormblade",
      description: "Updated description.",
      personalitySummary: "Now more talkative and open.",
      scenario: "A bustling port city at dawn.",
      systemPrompt: "Updated system prompt.",
      firstMessage: "*Aria waves from the dock.* Over here!",
      mesExample: "<START>\n{{user}}: Hello!\n{{char}}: *She grins.* Took you long enough.",
      alternateGreetings: ["Greeting A", "Greeting B"],
      postHistoryInstructions: "[Updated instructions.]",
      creatorNotes: "Updated notes.",
      depthPrompt: "New depth prompt content.",
      depthPromptDepth: 2,
      depthPromptRole: "user",
      tags: ["fantasy", "adventure", "updated"],
    };

    // The PATCH endpoint returns a full SessionSnapshot
    const result = await json<Snapshot>(
      await server.api(`/api/characters/${characterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PATCH),
      }),
    );

    const c = result.character;

    expect(c.name).toBe("Aria Stormblade");
    expect(c.description).toBe("Updated description.");
    expect(c.personalitySummary).toBe("Now more talkative and open.");
    expect(c.scenario).toBe("A bustling port city at dawn.");
    expect(c.systemPrompt).toBe("Updated system prompt.");
    expect(c.firstMessage).toContain("waves from the dock");
    expect(c.mesExample).toContain("Took you long enough");
    expect(c.alternateGreetings).toEqual(["Greeting A", "Greeting B"]);
    expect(c.postHistoryInstructions).toBe("[Updated instructions.]");
    expect(c.creatorNotes).toBe("Updated notes.");
    expect(c.depthPrompt).toBe("New depth prompt content.");
    expect(c.depthPromptDepth).toBe(2);
    expect(c.depthPromptRole).toBe("user");
    expect(c.tags).toEqual(["fantasy", "adventure", "updated"]);
  });

  it("nullifies optional fields correctly", async () => {
    const PATCH = {
      personalitySummary: null,
      mesExample: null,
      postHistoryInstructions: null,
      creatorNotes: null,
      depthPrompt: null,
      depthPromptDepth: null,
      depthPromptRole: null,
    };

    const result = await json<Snapshot>(
      await server.api(`/api/characters/${characterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PATCH),
      }),
    );

    const c = result.character;

    expect(c.personalitySummary).toBeNull();
    expect(c.mesExample).toBeNull();
    expect(c.postHistoryInstructions).toBeNull();
    expect(c.creatorNotes).toBeNull();
    expect(c.depthPrompt).toBeNull();
    expect(c.depthPromptDepth).toBeNull();
    expect(c.depthPromptRole).toBeNull();
  });
});
