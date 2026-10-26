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
 * The tool toggles (SC-5): the wire contract's five sidechat keys landed
 * BEFORE their tools (Wave 3 lands each tool and flips its toggle on) — all
 * five are known keys, all five have now landed (SC-10 the search pair,
 * SC-11 propose_objective, SC-12 todo + read_plan), and foreign keys stay
 * rejected.
 *
 * 5. The skill roots (SC-5): the built-in root resolves through the asset
 *    ladder to the shipped `agent-sidechat/skills` directory and scans the
 *    three built-in skills BS-3 authored (SC-5 shipped the root empty), and
 *    the user root derives as `<dataDir>/agent-sidechat/skills`.
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

  test("the six toggles are known keys; all six landed tools are on", () => {
    const kind = getAgentKind("sidechat-ooc");
    // The toggle names are the plan's settled contract, carried by the wire
    // schema (the single source of truth, re-exported for consumers).
    expect(SIDECHAT_OOC_TOOL_KEYS).toEqual([
      "search_context",
      "read_context_item",
      "propose_objective",
      "todo",
      "read_plan",
      "read_message_prompt",
    ]);
    // The schema accepts each of the six (either boolean) and the all-off
    // `{}` — tool sets store only enabled keys, so `{}` IS “all six
    // disabled”, what a user profile can still choose.
    expect(kind.toolSetSchema.parse({ search_context: true })).toEqual({ search_context: true });
    expect(kind.toolSetSchema.parse({ read_plan: false })).toEqual({ read_plan: false });
    expect(kind.toolSetSchema.parse({})).toEqual({});
    // Foreign keys (the experience kind's write_buffer, the script kind's
    // run_script_test) are rejected, not silently stripped — no profile can
    // toggle a tool this species does not serve.
    expect(kind.toolSetSchema.safeParse({ write_buffer: true }).success).toBe(false);
    expect(kind.toolSetSchema.safeParse({ run_script_test: true }).success).toBe(false);
    // SC-10 flipped the search pair, SC-11 `propose_objective`, SC-12
    // `todo` + `read_plan`, SC-23e `read_message_prompt` (each unit flips
    // its own keys) — all six tools have landed and the default set
    // carries them all.
    expect(kind.defaultToolSet).toEqual({
      search_context: true,
      read_context_item: true,
      propose_objective: true,
      todo: true,
      read_plan: true,
      read_message_prompt: true,
    });
  });
});

// ─── The builtin profile seed ────────────────────────────────────────────────

describe("resolveBuiltinCopilotProfile('sidechat-ooc') — the builtin seed", () => {
  test("carries the asset text byte-identical with all six tools enabled, and passes the wire profile schema", async () => {
    const seed = await resolveBuiltinCopilotProfile("sidechat-ooc");
    expect(seed.id).toBe("builtin");
    expect(seed.isBuiltIn).toBe(true);
    expect(seed.agentKind).toBe("sidechat-ooc");
    expect(seed.name).toBe(SIDECHAT_OOC_SEED_NAME);
    // The base prompt IS the `sidechat_ooc_base` asset (registry map → the
    // loader ladder), byte-identical — no wrapper, no trimming.
    const assetText = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    expect(seed.basePrompt).toBe(assetText);
    // SC-10 flipped the search pair, SC-11 `propose_objective`, SC-12 `todo`
    // + `read_plan`, SC-23e `read_message_prompt` — the seed carries every
    // landed tool.
    expect(seed.toolSet).toEqual({
      search_context: true,
      read_context_item: true,
      propose_objective: true,
      todo: true,
      read_plan: true,
      read_message_prompt: true,
    });

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

  // SC-21b (owner review 2026-10-21): the model also receives
  // `<rp_selection_changed>` (SC-2c) and `<rp_branch_forked` (SC-20) blocks,
  // and the base prompt must explain every tag it can meet. The seed's
  // basePrompt is byte-identical to this asset (asserted above), so pinning
  // the asset text pins the base prompt.
  test("explains the selection-change and branch-fork tags (SC-21b)", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    expect(text).toContain(
      '- `<rp_selection_changed>` means the user picked a different variant for an earlier message: the `<current>` text is now what happened, the `<previous>` text no longer did.',
    );
    expect(text).toContain(
      '- `<rp_branch_forked at="n"/>` means the story was branched after message n: everything after it comes from this branch, and earlier discussion of later messages refers to a story line that no longer exists here.',
    );
  });
});

// ─── The skill roots (SC-5) ──────────────────────────────────────────────

describe("the sidechat skill roots (SC-5)", () => {
  test("the built-in root resolves through the asset ladder and scans the BS-3 built-in skills", async () => {
    const root = await resolveSidechatSkillsRoot();
    // The root is the shipped assets directory (the locator-README climb the
    // script kind's root established), not a data dir and not another kind's
    // root.
    expect(root.replace(/\\/g, "/")).toMatch(/assets\/agent-sidechat\/skills$/);
    // Behavior change: was an EMPTY scan (SC-5 shipped the root, not
    // content) → now the three skills BS-3 authored, basis:
    // BUILTIN_AGENT_SKILLS_PLAN BS-3. Each `<skill-id>/SKILL.md` here appears
    // as a built-in entry; a manifest error would land in `errors`.
    const { entries, errors } = await buildSkillCatalog([{ path: root, source: "builtin" }]);
    expect(entries.map((e) => e.id).sort()).toEqual(["character-analysis", "continuity-check", "language-study"]);
    expect(entries.every((e) => e.source === "builtin")).toBe(true);
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
