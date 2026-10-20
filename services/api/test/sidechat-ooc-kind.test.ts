/**
 * The `sidechat-ooc` agent kind (SIDECHAT_PLAN, Wave 1 / SC-4a).
 *
 * Pins the unit's four points:
 * 1. The kind registers CHAT-OWNED — the first `owner: "chat"` kind:
 *    `getChatOwnedAgentKind` resolves it, the script-owned built-ins are
 *    refused by that seam, and `resolveKindForScript` never returns it
 *    (empty `servesScriptKinds` by design).
 * 2. The builtin profile seed carries the `agent-sidechat/ooc.md` asset text
 *    BYTE-IDENTICAL with an EMPTY tool set, and PASSES the wire profile
 *    schema — the generic kind seed's empty base deliberately fails
 *    `basePrompt: min(1)` (AS-3), which is why this kind needs its own seed
 *    before its first turn (SC-4b).
 * 3. The `sidechat_ooc_base` service-prompt override replaces the seed base
 *    on the builtin path (SP-5 parity, the `script` seed's pattern; a real
 *    in-memory DB, the profile tier).
 * 4. The asset pin (S2-0a style — pins cover ASSEMBLY, real assets must
 *    load): `agent-sidechat/ooc.md` loads non-empty through the registry map.
 *
 * The tool toggles (SC-5): the wire contract's five sidechat keys exist
 * BEFORE their tools (Wave 3 lands each tool and flips its toggle on) — all
 * five are known keys, every one starts DISABLED (tool sets store only
 * enabled keys, so the default set and the seed carry `{}`), and foreign
 * keys stay rejected.
 *
 * 5. The skill roots (SC-5): the built-in root resolves through the asset
 *    ladder to the shipped `agent-sidechat/skills` directory and scans EMPTY
 *    (no skill is authored — SC-5 ships the root, not content), and the user
 *    root derives as `<dataDir>/agent-sidechat/skills`.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { CHAT_MODE, SCRIPT_KIND } from "@vibe-tavern/domain";
import { copilotProfileSchema, SIDECHAT_OOC_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import { getServicePromptAssetFile } from "../src/domain/service-prompts/service-prompt-registry.js";
import { buildSkillCatalog } from "../src/domain/coauthor/skills/skill-scanner.js";
import {
  getAgentKind,
  getChatOwnedAgentKind,
  resolveKindForScript,
  kindServesChatMode,
  AgentKindNotChatOwnedError,
} from "../src/domain/agent/agent-kind-registry.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";
// Side-effect imports: register the script-owned built-ins so the
// "never resolves through the script-kind mapping" pin sees the real
// registry state (the sidechat kind registers through the copilot module's
// seed-dispatch import above, tests included).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";
import {
  SIDECHAT_OOC_SEED_NAME,
  resolveBuiltinSidechatOocProfile,
  resolveSidechatSkillsRoot,
  resolveSidechatUserSkillsRoot,
} from "../src/domain/agent/kinds/sidechat-ooc-kind.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const fixedClock: StoreClock = { now: () => "2026-10-20T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_${++counter}` };

/** Real in-memory DB with the Default service-prompt profile ensured — the
 *  same convention script-agent-prompt.test.ts uses for override-tier pins.
 *  Override-free fields resolve through the default asset ladder. */
async function setupDb() {
  counter = 0;
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  await profileStore.ensureDefaultServicePromptProfile();
  return { db, profileStore, uiSettings };
}

// ─── The kind descriptor ─────────────────────────────────────────────────────

describe("the sidechat-ooc agent kind (SC-4a)", () => {
  test("resolves as chat-owned; the script-owned built-ins are refused by the chat-owner seam", () => {
    const kind = getChatOwnedAgentKind("sidechat-ooc");
    expect(kind.id).toBe("sidechat-ooc");
    expect(kind.owner).toBe("chat");
    expect(kind.basePromptServiceKey).toBe("sidechat_ooc_base");
    expect(kind.skillRootId).toBe("sidechat");
    // Chat-owned kinds are never derived from a script kind.
    expect(kind.servesScriptKinds).toEqual([]);
    expect(kind).toBe(getAgentKind("sidechat-ooc"));

    // The owner split is real: the script-owned built-ins throw here (SC-0b),
    // so a chat-branch route can never serve them by accident.
    for (const scriptOwned of ["experience", "script"] as const) {
      let caught: unknown;
      try {
        getChatOwnedAgentKind(scriptOwned);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentKindNotChatOwnedError);
      expect((caught as AgentKindNotChatOwnedError).kindId).toBe(scriptOwned);
    }
  });

  test("resolveKindForScript never returns the sidechat kind for any real script kind", () => {
    for (const scriptKind of [SCRIPT_KIND.interactive, SCRIPT_KIND.prompt, SCRIPT_KIND.dice]) {
      expect(resolveKindForScript(scriptKind).id).not.toBe("sidechat-ooc");
    }
  });

  test("serves rp chats only — the SC-7b declaration (owner decision 8)", () => {
    const kind = getAgentKind("sidechat-ooc");
    // The ONE source: the descriptor's value is the plan's settled fact
    // (RP chats only), spelled in CHAT_MODE's vocabulary. The create guard,
    // the empty-read filter and the bootstrap wire field all read this.
    expect(kind.servesChatModes).toEqual([CHAT_MODE.rp]);
    expect(kindServesChatMode(kind, CHAT_MODE.rp)).toBe(true);
    expect(kindServesChatMode(kind, CHAT_MODE.coauthor)).toBe(false);
  });

  test("the five Wave-3 toggles are known keys, all disabled until their tools land (SC-5)", () => {
    const kind = getAgentKind("sidechat-ooc");
    // The toggle names are the plan's settled contract, carried by the wire
    // schema (the single source of truth, re-exported for consumers).
    expect(SIDECHAT_OOC_TOOL_KEYS).toEqual([
      "search_context",
      "read_context_item",
      "propose_objective",
      "todo",
      "read_plan",
    ]);
    // The schema accepts each of the five (either boolean) and the all-off
    // `{}` — tool sets store only enabled keys, so `{}` IS “all five
    // disabled” until Wave 3 flips one on.
    expect(kind.toolSetSchema.parse({ search_context: true })).toEqual({ search_context: true });
    expect(kind.toolSetSchema.parse({ read_plan: false })).toEqual({ read_plan: false });
    expect(kind.toolSetSchema.parse({})).toEqual({});
    // Foreign keys (the experience kind's write_buffer, the script kind's
    // run_script_test) are rejected, not silently stripped — no profile can
    // toggle a tool this species does not serve.
    expect(kind.toolSetSchema.safeParse({ write_buffer: true }).success).toBe(false);
    expect(kind.toolSetSchema.safeParse({ run_script_test: true }).success).toBe(false);
    // Nothing is enabled by default until Wave 3 lands a tool.
    expect(kind.defaultToolSet).toEqual({});
  });
});

// ─── The builtin profile seed ────────────────────────────────────────────────

describe("resolveBuiltinCopilotProfile('sidechat-ooc') — the builtin seed", () => {
  test("carries the asset text byte-identical with an empty tool set, and passes the wire profile schema", async () => {
    const seed = await resolveBuiltinCopilotProfile("sidechat-ooc");
    expect(seed.id).toBe("builtin");
    expect(seed.isBuiltIn).toBe(true);
    expect(seed.agentKind).toBe("sidechat-ooc");
    expect(seed.name).toBe(SIDECHAT_OOC_SEED_NAME);
    // The base prompt IS the `sidechat_ooc_base` asset (registry map → the
    // loader ladder), byte-identical — no wrapper, no trimming.
    const assetText = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    expect(seed.basePrompt).toBe(assetText);
    // Empty tool set until Wave 3.
    expect(seed.toolSet).toEqual({});

    // The unit's why: the seed passes the wire schema the generic kind seed
    // deliberately fails (empty base → min(1)); pin both sides.
    expect(copilotProfileSchema.safeParse(seed).success).toBe(true);
    expect(copilotProfileSchema.safeParse({ ...seed, basePrompt: "" }).success).toBe(false);

    // The dispatch reaches THIS species' seed (the kind module's own
    // resolver), not a generic shape.
    expect(seed).toEqual(await resolveBuiltinSidechatOocProfile());
  });

  test("a `sidechat_ooc_base` override replaces the seed base on the builtin path (SP-5 parity)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Sidechat base override",
      overrides: { sidechat_ooc_base: "CUSTOM SIDECHAT OOC BASE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const seed = await resolveBuiltinCopilotProfile("sidechat-ooc", db);
    expect(seed.basePrompt).toBe("CUSTOM SIDECHAT OOC BASE");
  });
});

// ─── The asset pin (S2-0a style: real assets must load) ─────────────────────

describe("the sidechat_ooc_base asset — SC-4a pin", () => {
  test("agent-sidechat/ooc.md loads non-empty through the registry map", async () => {
    expect(getServicePromptAssetFile("sidechat_ooc_base")).toBe("agent-sidechat/ooc.md");
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

// ─── The skill roots (SC-5) ──────────────────────────────────────────────

describe("the sidechat skill roots (SC-5)", () => {
  test("the built-in root resolves through the asset ladder and scans EMPTY — no skill is authored", async () => {
    const root = await resolveSidechatSkillsRoot();
    // The root is the shipped assets directory (the locator-README climb the
    // script kind's root established), not a data dir and not another kind's
    // root.
    expect(root.replace(/\\/g, "/")).toMatch(/assets\/agent-sidechat\/skills$/);
    // SC-5 ships the ROOT, not content: the catalog scans empty. The moment
    // someone authors `<skill-id>/SKILL.md` here it appears — until then a
    // pinned skill simply does not resolve (never fatal).
    const { entries, errors } = await buildSkillCatalog([{ path: root, source: "builtin" }]);
    expect(entries).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the user root derives as <dataDir>/agent-sidechat/skills (not created here)", async () => {
    // Derived at runtime — no path-separator assumption (the repo's
    // Windows-dev / Linux-CI split).
    const dataDir = await mkdtemp(join(tmpdir(), "vt-sidechat-kind-roots-"));
    try {
      expect(resolveSidechatUserSkillsRoot(dataDir)).toBe(join(dataDir, "agent-sidechat", "skills"));
      // The resolver only DERIVES the path; a missing root scans as empty.
      expect(await Bun.file(join(dataDir, "agent-sidechat", "skills")).exists()).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
