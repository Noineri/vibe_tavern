export {};

const { useDomEnv } = await import("../../test/dom-env.js");

useDomEnv();

const { afterAll, afterEach, beforeEach, describe, expect, mock, test } = await import("bun:test");
const imageGenApi = await import("./image-gen-api.js");

const originalFetch = globalThis.fetch;

type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(implementation: FetchImplementation): typeof fetch {
  return Object.assign(mock<FetchImplementation>(implementation), {
    preconnect: globalThis.fetch.preconnect,
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("image prompt-template API client", () => {
  test("uses typed profile-family routes and raw detection transport alongside the template catalog", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        cells: [],
        qualityCanon: {},
        assist: { core: "core", addenda: {} },
        families: [],
        rowKey: "portrait",
        family: "prose",
        canonText: "canon",
        canonSource: "family-canon",
        customText: null,
        qualityText: null,
        isCustomized: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await imageGenApi.listImagePromptFamilies();
    await imageGenApi.setImageGenProfileFamily("profile id", "pony");
    await imageGenApi.setImageGenProfileFamily("profile id", null);
    await imageGenApi.detectImageGenProfileFamily("profile id");

    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining("/api/image-gen/prompt-families"),
      expect.stringContaining("/api/image-gen/profiles/profile id/family"),
      expect.stringContaining("/api/image-gen/profiles/profile id/family"),
      expect.stringContaining("/api/image-gen/profiles/profile%20id/detect-family"),
    ]);
    expect(requests.map((request) => request.init?.method ?? "GET")).toEqual(["GET", "PUT", "PUT", "POST"]);
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ family: "pony" }));
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ family: null }));
  });
});

describe("image-gen listing client (IF-20)", () => {
  test("reads the snapshot header into snapshotAt; a live answer reports null; 404 stays null", async () => {
    const responses: Response[] = [
      new Response(JSON.stringify([{ id: "m", label: "M" }]), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-VT-Listing-Snapshot-At": "2026-09-29T10:00:00.000Z" },
      }),
      new Response(JSON.stringify({ encoders: ["e"], vaes: ["v"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response("missing", { status: 404 }),
    ];
    globalThis.fetch = mockFetch(async () => responses.shift()!);

    expect(await imageGenApi.listImageGenModels("p1")).toEqual({
      data: [{ id: "m", label: "M" }],
      snapshotAt: "2026-09-29T10:00:00.000Z",
    });
    expect(await imageGenApi.listImageGenDitSidecars("p1")).toEqual({
      data: { encoders: ["e"], vaes: ["v"] },
      snapshotAt: null,
    });
    expect(await imageGenApi.listImageGenModels("missing")).toBeNull();
  });
});
