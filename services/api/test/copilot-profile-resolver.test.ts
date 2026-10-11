import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type CopilotProfileRow, type StoreContainer } from "@vibe-tavern/db";
import {
  CopilotProfileResolver,
  copilotProfileRowToWire,
} from "../src/domain/interactive/copilot/copilot-profile-resolver.js";

/**
 * CP-6 — copilot profile resolution. Pins the fallback ladder: null scriptId /
 * missing script / no profile / dangling profile id all resolve to the built-in
 * read-only seed; an assigned profile resolves to the user row (projected to the
 * wire shape). Uses the real store container so the `copilotProfileId` column on
 * `scripts` is exercised end-to-end.
 */

let stores: StoreContainer;
let resolver: CopilotProfileResolver;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-profile-resolver-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  resolver = new CopilotProfileResolver(stores);
});

describe("CopilotProfileResolver", () => {
  test("null scriptId → built-in seed", async () => {
    const profile = await resolver.resolveForScript(null);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });

  test("a script with no profile → built-in seed (zero behavior change)", async () => {
    const script = await stores.scripts.create({ name: "No Profile", code: "", scriptKind: "interactive", scopeType: "global" });
    const profile = await resolver.resolveForScript(script.id);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });

  test("an assigned profile resolves to the user row (projected to wire shape)", async () => {
    const created = await stores.copilotProfiles.create({
      name: "Card games",
      basePrompt: "You are a card-game rules reviewer.",
      skillIds: ["experience-authoring"],
      toolSet: { write_buffer: true, run_test: false },
      maxSteps: 12,
    });
    const script = await stores.scripts.create({
      name: "Assigned",
      code: "",
      scriptKind: "interactive",
      scopeType: "global",
      copilotProfileId: created.id,
    });

    const profile = await resolver.resolveForScript(script.id);
    expect(profile.isBuiltIn).toBe(false);
    expect(profile.id).toBe(created.id);
    expect(profile.name).toBe("Card games");
    expect(profile.basePrompt).toBe("You are a card-game rules reviewer.");
    expect(profile.skillIds).toEqual(["experience-authoring"]);
    // Only true keys survive the strict projection (run_test: false dropped).
    expect(profile.toolSet).toEqual({ write_buffer: true });
    // TAG-4: maxSteps is no longer projected to the wire shape.
    expect(profile.maxSteps).toBeUndefined();
  });

  test("legacy todo:true projects to plan/read_plan, while rows without it get neither", () => {
    const row: CopilotProfileRow = {
      id: "profile_legacy",
      name: "Legacy",
      basePrompt: "Legacy prompt.",
      skillIds: [],
      toolSet: { todo: true },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(copilotProfileRowToWire(row).toolSet).toEqual({ plan: true, read_plan: true });
    expect(copilotProfileRowToWire({ ...row, toolSet: {} }).toolSet).toEqual({});
  });

  test("a dangling profile id (deleted profile) → built-in seed", async () => {
    const created = await stores.copilotProfiles.create({
      name: "Doomed",
      basePrompt: "Will be deleted.",
      skillIds: [],
      toolSet: {},
      maxSteps: 20,
    });
    const script = await stores.scripts.create({
      name: "Dangling",
      code: "",
      scriptKind: "interactive",
      scopeType: "global",
      copilotProfileId: created.id,
    });
    await stores.copilotProfiles.delete(created.id);

    const profile = await resolver.resolveForScript(script.id);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });

  test("a missing script → built-in seed", async () => {
    const profile = await resolver.resolveForScript("script_does_not_exist");
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });
});
