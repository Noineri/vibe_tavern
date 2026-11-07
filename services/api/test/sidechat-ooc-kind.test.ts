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
 * The tool toggles (SC-5): the wire contract's sidechat keys landed
 * BEFORE their tools (Wave 3 lands each tool and flips its toggle on) —
 * all nine TAG-1 keys have landed (SC-10 the search pair, SC-11
 * propose_objective, SC-12 todo + read_plan, SC-23e read_message_prompt,
 * DR-4a the director pair, DR-4b ask_user), and DMT-34 appended the three
 * director message tools TOGETHER with their finished implementation.
 * Foreign keys stay rejected.
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

  test("the thirteen toggles are known keys; the six landed OOC tools are on, the director keys, ask_user, the three message tools and propose_deck are known-but-off in the default", () => {
    const kind = getAgentKind("sidechat-ooc");
    // The toggle names are the plan's settled contract, carried by the wire
    // schema (the single source of truth, re-exported for consumers).
    // Behavior change (DR-4b): was 8 keys → now 9, `ask_user` appended
    // (owner ruling 2026-10-27, DIRECTOR_MODE_PLAN DR-4b ruling B) — off in
    // the OOC default, on in the `builtin-director` seed.
    // Behavior change (DMT-34): was 9 keys → now 12, the three director
    // message tools appended (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-34) — on in
    // the `builtin-director` seed, off in the OOC default and first seed.
    // Behavior change (DK-5a): was 12 keys → now 13, `propose_deck`
    // appended (DIRECTOR_DECK_CALENDAR_PLAN DK-5a, the DMT-34 land-together
    // pattern) — on in the `builtin-director` seed, off in the OOC default
    // and first seed.
    expect(SIDECHAT_OOC_TOOL_KEYS).toEqual([
      "search_context",
      "read_context_item",
      "propose_objective",
      "todo",
      "read_plan",
      "read_message_prompt",
      "propose_plan",
      "propose_tracker_template",
      "ask_user",
      "propose_message_edit",
      "propose_message_variant",
      "request_message_swipe",
      "propose_deck",
    ]);
    // The schema accepts each of the keys (either boolean) and the all-off
    // `{}` — tool sets store only enabled keys, so `{}` IS “all nine
    // disabled”, what a user profile can still choose.
    expect(kind.toolSetSchema.parse({ search_context: true })).toEqual({ search_context: true });
    expect(kind.toolSetSchema.parse({ read_plan: false })).toEqual({ read_plan: false });
    expect(kind.toolSetSchema.parse({ propose_plan: true })).toEqual({ propose_plan: true });
    expect(kind.toolSetSchema.parse({ ask_user: true })).toEqual({ ask_user: true });
    expect(kind.toolSetSchema.parse({})).toEqual({});
    // Foreign keys (the experience kind's write_buffer, the script kind's
    // run_script_test) are rejected, not silently stripped — no profile can
    // toggle a tool this species does not serve.
    expect(kind.toolSetSchema.safeParse({ write_buffer: true }).success).toBe(false);
    expect(kind.toolSetSchema.safeParse({ run_script_test: true }).success).toBe(false);
    // SC-10 flipped the search pair, SC-11 `propose_objective`, SC-12
    // `todo` + `read_plan`, SC-23e `read_message_prompt` (each unit flips
    // its own keys) — all six OOC tools have landed and the DEFAULT set
    // carries them all; the two director keys, `ask_user` and DMT-34's
    // three message-tool keys stay OFF in the kind default and the first
    // seed (the exact-equality pin asserts their absence; DR-4b's
    // `builtin-director` seed enables them).
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
    // landed OOC tool, and still none of the director-family keys
    // (DMT-34's three message tools included — the exact-equality pin
    // asserts their absence).
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

  test("the `builtin-director` seed carries the director asset with its own toggles (DR-4b + DMT-34 + DK-5a)", async () => {
    const director = await resolveBuiltinSidechatOocProfile(undefined, "builtin-director");
    expect(director.id).toBe("builtin-director");
    expect(director.name).toBe("Director");
    expect(director.isBuiltIn).toBe(true);
    expect(director.agentKind).toBe("sidechat-ooc");
    // The base prompt IS the `sidechat_director_base` asset (registry map →
    // the loader ladder), byte-identical — the OOC asset does NOT leak in.
    const assetText = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const oocText = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    expect(director.basePrompt).toBe(assetText);
    expect(director.basePrompt).not.toBe(oocText);
    // The OOC six MINUS propose_objective, PLUS the two DR-4a proposal tools,
    // ask_user (owner ruling 2026-10-27), DMT-34's three message tools and
    // DK-5a's `propose_deck` — the plan's DR-4 enumeration extended by
    // DIRECTOR_MESSAGE_TOOLS_PLAN DMT-34 and DIRECTOR_DECK_CALENDAR_PLAN
    // DK-5a.
    expect(director.toolSet).toEqual({
      search_context: true,
      read_context_item: true,
      todo: true,
      read_plan: true,
      read_message_prompt: true,
      propose_plan: true,
      propose_tracker_template: true,
      ask_user: true,
      propose_message_edit: true,
      propose_message_variant: true,
      request_message_swipe: true,
      propose_deck: true,
    });
    expect(copilotProfileSchema.safeParse(director).success).toBe(true);
    // The dispatch reaches the sidechat species' resolver for this seed too.
    expect(director).toEqual(await resolveBuiltinCopilotProfile("sidechat-ooc", undefined, "builtin-director"));
  });

  test("a `sidechat_director_base` override replaces the director seed base (SP-5 parity)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Director base override",
      overrides: { sidechat_director_base: "CUSTOM DIRECTOR BASE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const seed = await resolveBuiltinCopilotProfile("sidechat-ooc", db, "builtin-director");
    expect(seed.basePrompt).toBe("CUSTOM DIRECTOR BASE");
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

// ─── The director asset pin (DR-4b + DMT-34 — the plans' Asset contract) ───

/** Slice one `# Heading` section (heading line up to the next heading) out of
 *  a markdown asset — the verbatim-block pin's helper. */
function mdSection(text: string, heading: string): string {
  const start = text.indexOf(`# ${heading}`);
  if (start < 0) throw new Error(`fixture: no "# ${heading}" section`);
  const next = text.indexOf("\n# ", start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

describe("the sidechat_director_base asset — DR-4b pin", () => {
  test("agent-sidechat/director.md loads non-empty through the registry map", async () => {
    expect(getServicePromptAssetFile("sidechat_director_base")).toBe("agent-sidechat/director.md");
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test("the role line: story director, out of character, never writes the roleplay, never speaks for the user's character", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    expect(text).toContain("You are the Director — the story director of this roleplay branch.");
    expect(text).toContain("You never write the roleplay itself and never speak for the user's character.");
  });

  test("session zero: asks BEFORE planning — genre, tone, boundaries, pacing, the arc, ending vs open end — through ask_user with options", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const sessionZero = mdSection(text, "Session zero");
    expect(sessionZero).toContain("Before proposing any plan, ask what story the user wants");
    expect(sessionZero).toContain("through `ask_user` with option chips");
    for (const item of ["genre and setting", "tone", "boundaries", "pacing", "the arc", "the ending — a planned ending or an open end"]) {
      expect(sessionZero).toContain(`- ${item}`);
    }
    expect(sessionZero).toContain("propose the complete plan with `propose_plan`");
  });

  test("plan semantics: premise hidden from the RP model; constraints = story rules; task titles brief, bodies current-only", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const plan = mdSection(text, "The story plan");
    expect(plan).toContain("the roleplay model NEVER receives it");
    expect(plan).toContain("constraints are the story rules");
    expect(plan).toContain("the title names the event in a few words");
    expect(plan).toContain(
      "write it only for the event that is current, never for later events",
    );
    expect(plan).toContain("One event at a time is current: the goal tracker carries the current event to the roleplay model");
    expect(plan).toContain("You propose status changes only when the user asks, or when the check clearly missed");
  });

  test("the check protocol triggers on «Сверь игру с планом.» and never rewrites completed events", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const check = mdSection(text, "Checking the game against the plan");
    // The RU command is a button/command name the model must echo exactly —
    // pinned VERBATIM (the plan's own two sanctioned Cyrillic phrases).
    expect(check).toContain("«Сверь игру с планом.»");
    expect(check).toContain('"Check the game against the plan."');
    expect(check).toContain("read the roleplay that has happened since your last turn, and the plan's statuses");
    expect(check).toContain("never rewrite completed events");
    expect(check).toContain("off-plan play is not punished");
    expect(check).toContain("the user decides");
  });

  test("tracker setup: offers propose_tracker_template and mentions «Сохранить как заготовку персонажа»", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const tracker = mdSection(text, "Scene tracker");
    expect(tracker).toContain("propose the setup with `propose_tracker_template`");
    expect(tracker).toContain("«Сохранить как заготовку персонажа»");
  });

  // DMT-34: the asset teaches the three finished message tools — the
  // plan's required content (three-way choice, mechanical-edit scope,
  // seen-source grounding, preview/permission, the editable one-shot
  // instruction, deny handling, honest outcomes).
  test("teaches the three Director message tools (DMT-34)", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const fixing = mdSection(text, "Fixing a reply");
    // The three-way choice: edit delegates to the editor, the variant is
    // the Director's own complete text, the swipe regenerates through the
    // RP model.
    expect(fixing).toContain(
      "`propose_message_edit` delegates a mechanical correction to the ordinary message editor",
    );
    expect(fixing).toContain(
      "`propose_message_variant` is your own alternative reply: you write the COMPLETE text yourself",
    );
    expect(fixing).toContain(
      "`request_message_swipe` proposes a one-shot regeneration through the normal roleplay model",
    );
    // Mechanical-edit scope: new content direction is a variant, never an edit.
    expect(fixing).toContain("New content direction is never an edit; that is a variant.");
    // Seen-source grounding: only shown or discussed replies, never guessed.
    expect(fixing).toContain("Only target replies the user has shown or discussed in this sidechat");
    expect(fixing).toContain("Never guess at content you have not seen");
    // Preview/permission: review cards the user acts on; nothing applies itself.
    expect(fixing).toContain("review cards the user must Apply or Save");
    expect(fixing).toContain("Nothing changes until the user acts — never assume a proposal was applied.");
    // The editable one-shot instruction: complete and self-contained.
    expect(fixing).toContain("write it complete and self-contained, because the user may allow it verbatim.");
    // Deny handling + honest outcomes.
    expect(fixing).toContain("A denied swipe does nothing — no retry, no variant; accept the denial and move on.");
    expect(fixing).toContain("a granted swipe means the run was SENT");
    expect(fixing).toContain("Never claim a variant was saved when it was not.");
  });

  test("the OOC asset's RP-sync rules are copied in VERBATIM (the whole Reading the RP material section)", async () => {
    const director = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const ooc = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_base"));
    // The plan's Asset contract: the OOC asset's RP-sync rules ride the
    // director asset unchanged — byte-for-byte, not paraphrased.
    expect(director).toContain(mdSection(ooc, "Reading the RP material"));
  });

  test("the only Cyrillic in the asset is the two sanctioned phrases", async () => {
    const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_director_base"));
    const withoutSanctioned = text
      .replaceAll("«Сверь игру с планом.»", "")
      .replaceAll("«Сохранить как заготовку персонажа»", "");
    expect(withoutSanctioned).not.toMatch(/[\u0400-\u04FF]/);
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
