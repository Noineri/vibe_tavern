import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type CopilotProfileRow, type StoreContainer } from "@vibe-tavern/db";
import {
  CopilotProfileResolver,
  copilotProfileRowToWire,
} from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
// Side-effect imports: register the built-in agent kinds so the kind-aware
// fallback (AS-8b — the builtin seed kind derives from the script row through
// the registry) holds regardless of which test file the shared process
// loaded first.
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

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
      toolSet: { write_buffer: true, run_test: false },
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
    // PM-8 (owner ruling 2026-10-12): skillIds is retired from the wire — the
    // catalog is ungated, so the profile carries no skill allow-list.
    expect(profile).not.toHaveProperty("skillIds");
    // Only true keys survive the strict projection (run_test: false dropped).
    expect(profile.toolSet).toEqual({ write_buffer: true });
    // TAG-4: maxSteps is no longer projected to the wire shape.
    expect(profile.maxSteps).toBeUndefined();
  });

  test("a stored todo:true projects to todo:true and NOTHING else (PM-7 no-alias boundary)", () => {
    // PM-7 (owner ruling 2026-10-11): `todo` is a real toolset key again —
    // the PM-2 alias that projected a legacy `todo: true` onto `plan` +
    // `read_plan` was REMOVED with the todo mechanic's restoration (todo =
    // the thread's session checklist beside the plan).
    const row: CopilotProfileRow = {
      id: "profile_legacy",
      name: "Legacy",
      basePrompt: "Legacy prompt.",
      toolSet: { todo: true },
      // AS-3: rows always carry their owning kind (pre-AS-3 rows read as
      // 'experience' via the column default).
      agentKind: "experience",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(copilotProfileRowToWire(row).toolSet).toEqual({ todo: true });
    expect(copilotProfileRowToWire(row).toolSet.plan).toBeUndefined();
    expect(copilotProfileRowToWire(row).toolSet.read_plan).toBeUndefined();
    expect(copilotProfileRowToWire({ ...row, toolSet: {} }).toolSet).toEqual({});
  });

  test("a dangling profile id (deleted profile) → built-in seed", async () => {
    const created = await stores.copilotProfiles.create({
      name: "Doomed",
      basePrompt: "Will be deleted.",
      toolSet: {},
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

describe("CopilotProfileResolver — kind-aware builtin seed (AS-8b)", () => {
  test("prompt and dice scripts with no assigned profile → the builtin `script` seed", async () => {
    for (const scriptKind of ["prompt", "dice"] as const) {
      const script = await stores.scripts.create({ name: `Seed ${scriptKind}`, code: "", scriptKind, scopeType: "global" });
      const profile = await resolver.resolveForScript(script.id);
      expect(profile.isBuiltIn).toBe(true);
      expect(profile.id).toBe("builtin");
      expect(profile.agentKind).toBe("script");
    }
  });

  test("an interactive script with no assigned profile → the experience seed", async () => {
    const script = await stores.scripts.create({ name: "Seed interactive", code: "", scriptKind: "interactive", scopeType: "global" });
    const profile = await resolver.resolveForScript(script.id);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.agentKind).toBe("experience");
  });

  test("a prompt script whose assigned profile row was deleted → the `script` seed (dangling profile id)", async () => {
    const created = await stores.copilotProfiles.create({
      name: "Doomed script profile",
      basePrompt: "Will be deleted.",
      toolSet: {},
    });
    const script = await stores.scripts.create({
      name: "Dangling prompt",
      code: "",
      scriptKind: "prompt",
      scopeType: "global",
      copilotProfileId: created.id,
    });
    await stores.copilotProfiles.delete(created.id);

    const profile = await resolver.resolveForScript(script.id);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.agentKind).toBe("script");
  });

  test("scriptId === null (a draft) and a dangling script row → the experience seed", async () => {
    const draft = await resolver.resolveForScript(null);
    expect(draft.isBuiltIn).toBe(true);
    expect(draft.agentKind).toBe("experience");

    const dangling = await resolver.resolveForScript("script_does_not_exist");
    expect(dangling.isBuiltIn).toBe(true);
    expect(dangling.agentKind).toBe("experience");
  });
});
