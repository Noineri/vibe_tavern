import { afterAll, beforeEach, expect, test } from "bun:test";
import { brandId, normalizeTrackerTemplate, type ChatId } from "@vibe-tavern/domain";
import { testFetch } from "@vibe-tavern/test-fetch";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { getTrackerTemplate, updateTrackerTemplate } = await import("./character-api.js");
const { saveAsCharacterTrackerTemplate } = await import("./tracker-template-api.js");

// L1: (1) no filesystem paths; (2) fetch restored beforeEach/afterAll;
// (3) awaited responses, no timers; (4) URL parsing, no OS assumptions;
// (5) injected fetch, no module mocks; (6) assertions after resolved RPC calls;
// (7) no DB/build/setup work, fresh in-memory request capture per test.
const originalFetch = globalThis.fetch;
let template: unknown;
let requests: Array<{ path: string; init?: RequestInit }>;
beforeEach(() => {
  globalThis.fetch = originalFetch;
  requests = [];
  template = null;
  globalThis.fetch = testFetch(async (input, init) => {
    requests.push({ path: new URL(String(input), "http://gateway.test").pathname, init });
    return Response.json({ template });
  });
});
afterAll(() => { globalThis.fetch = originalFetch; });

function nestedTemplate() {
  const result = normalizeTrackerTemplate({
    version: 1,
    scene: { enabled: true, config: { schema: {
      party: { $type: "array", items: { $type: "object", properties: {
        name: { $type: "string", label: "Name" },
        inventory: { $type: "array", items: { $type: "string" } },
      } } },
    } } },
  });
  if (result === null) throw new Error("Invalid template fixture");
  return result;
}

test("an absent character template stays null", async () => {
  expect(await getTrackerTemplate("character")).toBeNull();
  expect(requests[0]?.path.endsWith("/api/characters/character/tracker-template")).toBe(true);
});

test("character GET/PUT and save-as preserve the same recursive portable template", async () => {
  const expected = nestedTemplate();
  template = expected;
  const loaded = await getTrackerTemplate("character");
  expect(loaded).toEqual(expected);
  expect(await updateTrackerTemplate("character", expected)).toEqual(expected);
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ template: expected });
  expect(requests[1]?.init?.method).toBe("PUT");
  expect(await saveAsCharacterTrackerTemplate(brandId<ChatId>("chat"))).toEqual(expected);
  expect(requests[2]?.path.endsWith("/api/chats/chat/insights/save-as-character-template")).toBe(true);
});

test("an unsupported template version cannot enter domain-typed client state", async () => {
  template = { ...nestedTemplate(), version: 999 };
  await expect(getTrackerTemplate("character")).rejects.toThrow("Invalid tracker template response");
  await expect(updateTrackerTemplate("character", nestedTemplate())).rejects.toThrow("Invalid tracker template response");
  await expect(saveAsCharacterTrackerTemplate(brandId<ChatId>("chat"))).rejects.toThrow("Invalid tracker template response");
});
