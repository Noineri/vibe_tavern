/**
 * Built-in skill achievability guard (BUILTIN_AGENT_SKILLS_PLAN, Wave 1 / BS-1).
 *
 * A built-in assistant skill (script kind under `assets/agent-script/skills`,
 * sidechat kind under `assets/agent-sidechat/skills`) may describe ONLY what
 * the product can do today. This guard enforces that mechanically instead of
 * by review:
 *
 * - [example-runs] every fenced block tagged ```js prompt runs through the
 *   real `executeScripts` sandbox on the plan's sample inputs (messages incl.
 *   one user + one assistant turn, a character, a persona) with no errors;
 *   every ```js dice block is discovered by `discoverDiceChecks` with no error
 *   and each registered check rolls once through `executeDiceRoll` with no
 *   error.
 * - [kind-tag] a ```js block without a valid kind tag fails — the kind is
 *   mandatory (prompt and dice sandboxes have different APIs).
 * - [context-surface] every `context.<member>` path written in a script skill
 *   (prose or code) exists in the surface of the kind its block or section
 *   names. Top-level channels come from `ALLOWED_SCRIPT_GLOBALS` (the one
 *   executable surface registry); deeper members are checked against a LIVE
 *   key dump of the real sandboxes — never a hand-written list. A path that
 *   exists for the other kind only fails with a message naming that kind.
 * - [tool-mention] every backticked snake_case token a skill names (minus the
 *   live context-member names, the XML tag names shown in the skill, and the
 *   kind's base-prompt vocabulary) must be a tool the kind actually serves.
 *   Script tools are derived from `buildScriptAgentTools` (the real builder —
 *   includes the ungated `read_skill_file`); sidechat tools from
 *   `SIDECHAT_OOC_TOOL_KEYS`. Code blocks are excluded from this scan — a
 *   backticked token inside script code is a template literal (a state key),
 *   never a tool call.
 * - [planned-surface] `context.host` / `context.net` / `context.memory`
 *   (SCRIPT_OFFICIAL_CAPABILITIES_PLAN, release someday) never appear in any
 *   skill. This list is fixed by the plan itself — those members exist in no
 *   code, so no runtime derivation is possible. The [context-surface] rule
 *   defers to it: a path whose top-level member is planned is reported here
 *   only, once, with the planned-surface message.
 * - [manifest] every SKILL.md parses through `parseSkillManifest`, its `name`
 *   equals its folder id, and its `description` is non-empty.
 *
 * With both built-in roots empty (READMEs only) the real-root run passes
 * vacuously; each rule is therefore proven by a FAILING fixture on a temp
 * root, plus positive controls that pin the no-false-positive shape.
 *
 * Only SKILL.md files are scanned — the catalog/model read a skill through its
 * manifest, and optional sibling files ride the same root when they exist.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPT_KIND, type DiceActorSnapshot, type RandomSource } from "@vibe-tavern/domain";
// Deep import: `script-safety.ts` is deliberately not re-exported from the
// domain barrel (same pattern as `@vibe-tavern/domain/builtins`); this is the
// ONE executable surface registry the guard must read.
import { ALLOWED_SCRIPT_GLOBALS } from "@vibe-tavern/domain/src/script-safety.js";
import { SIDECHAT_OOC_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import { createStoreContainer } from "@vibe-tavern/db";
import { executeScripts } from "../src/domain/scripts-engine/script-sandbox.js";
import { discoverDiceChecks, executeDiceRoll } from "../src/domain/scripts-engine/dice-script-sandbox.js";
import { scanSkillRoot } from "../src/domain/coauthor/skills/skill-scanner.js";
import { buildScriptAgentTools } from "../src/domain/agent/script-agent/script-agent-tools.js";
import { resolveScriptAgentSkillsRoot } from "../src/domain/agent/script-agent/script-agent-module.js";
import { resolveSidechatSkillsRoot } from "../src/domain/agent/kinds/sidechat-ooc-kind.js";
import { getServicePromptAssetFile } from "../src/domain/service-prompts/service-prompt-registry.js";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

/** The plan's sample inputs for running prompt examples: a few messages
 *  (at least one user and one assistant turn), a character, a persona. */
const SAMPLE_MESSAGES = [
  { message: "hello there, traveler", role: "user" },
  { message: "greetings — what brings you here?", role: "assistant" },
  { message: "let us see what happens next", role: "user" },
];
const SAMPLE_CHARACTER = { name: "Theron", personality: "warm and cautious", scenario: "a quiet tavern at dusk" };
const SAMPLE_PERSONA = { name: "Ari", description: "A curious wanderer." };
const SAMPLE_LORE = [{ title: "The Tavern", content: "A wooden hall by the crossroads.", keys: ["tavern"] }];

/** Deterministic roll context for dice examples (the guard only requires that
 *  a check CAN roll — intBelow → 0 pins every face at 1). */
const DICE_PROBE_ACTOR: DiceActorSnapshot = { actorType: "persona", actorId: "persona_probe", actorLabel: "Probe" };
const DICE_PROBE_RNG: RandomSource = { intBelow: () => 0 };
const DICE_PROBE_CONTEXT = { actor: DICE_PROBE_ACTOR, priorAttempts: [], rng: DICE_PROBE_RNG };

/** Planned surfaces excluded from every skill by plan ruling — they exist in
 *  no code (that is the point), so the list is quoted from
 *  BUILTIN_AGENT_SKILLS_PLAN / SCRIPT_OFFICIAL_CAPABILITIES_PLAN verbatim. */
const PLANNED_CONTEXT_MEMBERS = ["host", "net", "memory"] as const;

const API_ASSETS_DIR = join(import.meta.dir, "..", "assets");

// ─── Live sandbox surfaces (the single deep-member source) ──────────────────

/** Recursive enumerable-key shape of a sandbox `context` (null = leaf). */
type SurfaceTree = Record<string, SurfaceTree | null>;

/** Runs in either sandbox: dumps `context`'s own keys `depth` levels deep.
 *  Arrays become null (index keys are never path segments); functions become
 *  null leaves — key EXISTENCE is all the guard needs. */
const SURFACE_DUMP_BODY = `
function __vtDumpSurface(value, depth) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth === 0) return null;
  var out = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) out[keys[i]] = __vtDumpSurface(value[keys[i]], depth - 1);
  return out;
}
`;

/** Narrow a VM-returned dump (`unknown`) into a SurfaceTree without casts. */
function toSurfaceTree(value: unknown, depth = 0): SurfaceTree | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (depth > 8) return null;
  const out: SurfaceTree = {};
  for (const [key, child] of Object.entries(value)) out[key] = toSurfaceTree(child, depth + 1);
  return out;
}

/** The prompt sandbox's live surface: run the dump in `executeScripts` with
 *  the full sample input (persona included — `context.persona` exists only
 *  when the caller passes one) and read it back through the captured console. */
function dumpPromptSurface(): SurfaceTree {
  const result = executeScripts({
    scripts: [{ id: "surface-probe", name: "surface-probe", code: `${SURFACE_DUMP_BODY}\nconsole.log(JSON.stringify(__vtDumpSurface(context, 5)));`, sortOrder: 0 }],
    chat: { messages: SAMPLE_MESSAGES },
    character: SAMPLE_CHARACTER,
    activeLoreEntries: SAMPLE_LORE,
    scriptState: {},
    persona: SAMPLE_PERSONA,
  });
  const entry = result.scriptRuns[0]?.console[0];
  if (result.errors.length > 0 || entry === undefined) {
    throw new Error(`surface probe failed in the prompt sandbox: ${result.errors[0]?.error ?? "no console output"}`);
  }
  const parsed: unknown = JSON.parse(entry.args);
  const tree = toSurfaceTree(parsed);
  if (tree === null) throw new Error("prompt surface probe returned no object");
  return tree;
}

/** The dice sandbox's live surface: the roll phase is a strict superset of
 *  discovery (same `dice` channel plus the frozen `actor` / `priorAttempts`),
 *  and `executeDiceRoll` is the only phase whose resolve() output escapes the
 *  VM — so the dump registers one probe check and returns the tree from
 *  resolve(). */
function dumpDiceSurface(): SurfaceTree {
  const code = `${SURFACE_DUMP_BODY}
context.dice.register({
  id: "surface_probe",
  label: "surface probe",
  notation: "1d6",
  actors: ["persona"],
  resolution: "narrative",
  resolve() { return __vtDumpSurface(context, 5); },
});`;
  const roll = executeDiceRoll(code, "surface-probe.js", "surface_probe", DICE_PROBE_CONTEXT);
  if (!roll.ok) throw new Error(`surface probe failed in the dice sandbox: ${roll.error ?? "no output"}`);
  const tree = toSurfaceTree(roll.output);
  if (tree === null) throw new Error("dice surface probe returned no object");
  return tree;
}

/** Does a dotted `context` path exist in a dumped surface? */
function pathInSurface(tree: SurfaceTree, segments: readonly string[]): boolean {
  let node: SurfaceTree | null = tree;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || !(segment in node)) return false;
    node = node[segment] as SurfaceTree | null;
  }
  return true;
}

// ─── Derived tool sets and vocabularies (no hand-written tool list) ─────────

type SkillKind = "script" | "sidechat";

let PROMPT_SURFACE: SurfaceTree = {};
let DICE_SURFACE: SurfaceTree = {};
let SURFACE_MEMBER_NAMES: ReadonlySet<string> = new Set();
let SCRIPT_SERVED_TOOLS: ReadonlySet<string> = new Set();
let SCRIPT_BASE_VOCAB: ReadonlySet<string> = new Set();
let SIDECHAT_BASE_VOCAB: ReadonlySet<string> = new Set();
/** The sidechat's served tools — the plan names this export as the source. */
const SIDECHAT_SERVED_TOOLS: ReadonlySet<string> = new Set(SIDECHAT_OOC_TOOL_KEYS);

function servedTools(kind: SkillKind): ReadonlySet<string> {
  return kind === "script" ? SCRIPT_SERVED_TOOLS : SIDECHAT_SERVED_TOOLS;
}

function baseVocab(kind: SkillKind): ReadonlySet<string> {
  return kind === "script" ? SCRIPT_BASE_VOCAB : SIDECHAT_BASE_VOCAB;
}

/** Every snake_case word in a text (the base prompts name their tools, tags
 *  and result codes — the assistant's taught vocabulary). */
function snakeTokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) tokens.add(match[0]);
  return tokens;
}

/** All key names anywhere in both live surfaces (context-member vocabulary —
 *  covers the snake_case Janitor aliases such as `last_message`). */
function surfaceMemberNames(...trees: SurfaceTree[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: SurfaceTree | null): void => {
    if (node === null) return;
    for (const [key, child] of Object.entries(node)) {
      names.add(key);
      walk(child);
    }
  };
  for (const tree of trees) walk(tree);
  return names;
}

// ─── Markdown segmentation (blocks, kinds, sections) ────────────────────────

interface MdSegment {
  readonly type: "heading" | "prose" | "code";
  /** For ```js prompt / ```js dice fences: the tagged kind. */
  readonly kind: "prompt" | "dice" | null;
  /** True for any ```js fence (kind-tagged or not — untagged ones fail). */
  readonly jsFence: boolean;
  readonly text: string;
}

/** Split a SKILL.md into headings, prose runs and fenced blocks. A fence opens
 *  at a ``` line and closes at the next one (an unclosed fence runs to EOF);
 *  each heading line is its own segment (it switches the active section kind).
 *  Only fences whose info string starts with exactly `js` are script blocks. */
function segmentMarkdown(text: string): MdSegment[] {
  const segments: MdSegment[] = [];
  let prose: string[] = [];
  let fence: { info: string; body: string[] } | null = null;

  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ type: "prose", kind: null, jsFence: false, text: prose.join("\n") });
      prose = [];
    }
  };
  const flushHeading = (line: string): void => {
    flushProse();
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    segments.push({ type: "heading", kind: null, jsFence: false, text: heading?.[1]?.trim() ?? "" });
  };
  const flushFence = (): void => {
    if (!fence) return;
    const infoTokens = fence.info.trim().split(/\s+/).filter(Boolean);
    const jsFence = infoTokens[0] === "js";
    const kind = jsFence && (infoTokens[1] === "prompt" || infoTokens[1] === "dice") ? infoTokens[1] : null;
    segments.push({ type: "code", kind, jsFence, text: fence.body.join("\n") });
    fence = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      if (/^\s*```/.test(line)) flushFence();
      else fence.body.push(line);
      continue;
    }
    const opened = line.match(/^\s*```(.*)$/);
    if (opened) {
      flushProse();
      fence = { info: opened[1] ?? "", body: [] };
      continue;
    }
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      flushHeading(line);
      continue;
    }
    prose.push(line);
  }
  flushFence();
  flushProse();
  return segments;
}

/** The kind a section heading names — `prompt` or `dice` when the heading
 *  mentions exactly one of the two words, else null (union semantics). */
function sectionKindOf(heading: string): "prompt" | "dice" | null {
  const hasPrompt = /\bprompt\b/i.test(heading);
  const hasDice = /\bdice\b/i.test(heading);
  if (hasPrompt === hasDice) return null;
  return hasPrompt ? "prompt" : "dice";
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/** Dotted `context.*` paths written in a text. Preceded-by-word-char or by a
 *  dot (a property named `context` on another object) does not count. */
function extractContextPaths(text: string): string[][] {
  const paths: string[][] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z0-9_$.])context((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g)) {
    const key = match[1] ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(key.slice(1).split("."));
  }
  return paths;
}

/** Backticked snake_case tokens in a prose run that look like tool mentions:
 *  minus served tools, live context-member names, XML tag names shown
 *  anywhere in the same skill, and the kind's base-prompt vocabulary. */
function extractToolMentions(segmentText: string, kind: SkillKind, wholeSkillText: string): string[] {
  const tagNames = new Set<string>();
  for (const match of wholeSkillText.matchAll(/<\/?([a-z][a-z0-9_]*)/g)) tagNames.add(match[1] ?? "");
  const served = servedTools(kind);
  const mentions: string[] = [];
  for (const match of segmentText.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const token = match[1] ?? "";
    if (served.has(token)) continue;
    if (SURFACE_MEMBER_NAMES.has(token)) continue;
    if (tagNames.has(token)) continue;
    if (baseVocab(kind).has(token)) continue;
    if (!mentions.includes(token)) mentions.push(token);
  }
  return mentions;
}

// ─── The checker ─────────────────────────────────────────────────────────────

/** Top-level channel: `ALLOWED_SCRIPT_GLOBALS` (the one executable surface
 *  registry); deeper members: the live sandbox dump for that kind. */
function surfaceHas(kind: "prompt" | "dice", path: readonly string[]): boolean {
  const channels = ALLOWED_SCRIPT_GLOBALS[SCRIPT_KIND[kind]].contextChannels;
  const top = path[0];
  if (top === undefined || !channels.includes(top)) return false;
  if (path.length === 1) return true;
  return pathInSurface(kind === "prompt" ? PROMPT_SURFACE : DICE_SURFACE, path);
}

/** True when the path's top-level member is a planned surface — those are
 *  owned by the [planned-surface] rule, not by [context-surface]. */
function isPlannedPath(path: readonly string[]): boolean {
  const top = path[0];
  return top !== undefined && (PLANNED_CONTEXT_MEMBERS as readonly string[]).includes(top);
}

/** Violation text for a path under one named kind, or null when it is valid. */
function contextPathViolation(path: readonly string[], kind: "prompt" | "dice"): string | null {
  if (surfaceHas(kind, path)) return null;
  const other = kind === "prompt" ? "dice" : "prompt";
  const pretty = `context.${path.join(".")}`;
  if (surfaceHas(other, path)) {
    return `${pretty} is a ${other}-kind member — it exists only in the ${other} sandbox; keep it in a ${other === "dice" ? "```js dice" : "```js prompt"} example or section`;
  }
  return `${pretty} does not exist in any script sandbox (prompt or dice)`;
}

/** Check one SKILL.md's full text. `label` is the root-relative file path. */
function checkSkillText(text: string, label: string, kind: SkillKind): string[] {
  const out: string[] = [];
  let sectionKind: "prompt" | "dice" | null = null;
  let blockNo = 0;

  for (const segment of segmentMarkdown(text)) {
    if (segment.type === "heading") {
      sectionKind = sectionKindOf(segment.text);
      continue;
    }

    if (segment.type === "code" && segment.jsFence) {
      blockNo += 1;
      if (segment.kind === null) {
        out.push(`[kind-tag] ${label}: fenced js block #${blockNo} has no valid kind tag — tag it \`\`\`js prompt or \`\`\`js dice (the kind is mandatory)`);
        continue;
      }
      if (segment.kind === "prompt") {
        const run = executeScripts({
          scripts: [{ id: `block-${blockNo}`, name: `${label} block #${blockNo}`, code: segment.text, sortOrder: 0 }],
          chat: { messages: SAMPLE_MESSAGES },
          character: SAMPLE_CHARACTER,
          activeLoreEntries: SAMPLE_LORE,
          scriptState: {},
          persona: SAMPLE_PERSONA,
        });
        for (const error of run.errors) {
          out.push(`[example-runs] ${label}: \`\`\`js prompt example block #${blockNo} failed in the real prompt sandbox: ${error.error}`);
        }
      } else {
        const scriptName = `${label} block #${blockNo}`;
        const discovery = discoverDiceChecks(segment.text, scriptName);
        if (discovery.error !== null) {
          out.push(`[example-runs] ${label}: \`\`\`js dice example block #${blockNo} failed discovery in the real dice sandbox: ${discovery.error}`);
        }
        for (const registration of discovery.registrations) {
          const roll = executeDiceRoll(segment.text, scriptName, String(registration.id), DICE_PROBE_CONTEXT);
          if (!roll.ok) {
            out.push(`[example-runs] ${label}: \`\`\`js dice example block #${blockNo} check "${String(registration.id)}" failed its sample roll: ${roll.error ?? "no output"}`);
          }
        }
      }
      if (kind === "script") {
        for (const path of extractContextPaths(segment.text)) {
          if (isPlannedPath(path)) continue;
          const violation = contextPathViolation(path, segment.kind);
          if (violation !== null) out.push(`[context-surface] ${label}: ${violation}`);
        }
      }
      continue;
    }

    // Prose (or a non-js fence): path check against the section's kind — or
    // the union of both kinds when the section names neither/both.
    if (kind === "script") {
      for (const path of extractContextPaths(segment.text)) {
        if (isPlannedPath(path)) continue;
        if (sectionKind !== null) {
          const violation = contextPathViolation(path, sectionKind);
          if (violation !== null) out.push(`[context-surface] ${label}: ${violation}`);
        } else if (!surfaceHas("prompt", path) && !surfaceHas("dice", path)) {
          out.push(`[context-surface] ${label}: context.${path.join(".")} does not exist in any script sandbox (prompt or dice)`);
        }
      }
    }
    for (const token of extractToolMentions(segment.text, kind, text)) {
      out.push(`[tool-mention] ${label}: \`${token}\` is not a ${kind === "script" ? "script-assistant" : "sidechat"} tool — served tools: ${[...servedTools(kind)].sort().join(", ")}`);
    }
  }

  for (const member of PLANNED_CONTEXT_MEMBERS) {
    if (new RegExp(String.raw`(?<![A-Za-z0-9_$.])context\s*\.\s*${member}\b`).test(text)) {
      out.push(`[planned-surface] ${label}: context.${member} is a planned surface (SCRIPT_OFFICIAL_CAPABILITIES_PLAN) — it never appears in a skill`);
    }
  }
  return out;
}

/** Scan one skills root and return every achievability violation. */
async function checkSkillsRoot(rootPath: string, kind: SkillKind): Promise<string[]> {
  const violations: string[] = [];
  const { skills, errors } = await scanSkillRoot({ path: rootPath, source: "builtin" });

  for (const error of errors) {
    violations.push(`[manifest] ${relative(rootPath, error.skillDir) || error.skillDir}: ${error.reason}`);
  }
  for (const skill of skills) {
    const label = `${skill.id}/SKILL.md`;
    if (skill.name !== skill.id) {
      violations.push(`[manifest] ${label}: manifest name "${skill.name}" does not match its folder id "${skill.id}"`);
    }
    if (skill.description === "") {
      violations.push(`[manifest] ${label}: frontmatter description is empty — the catalog line is mandatory`);
    }
    const text = await Bun.file(skill.manifestPath).text();
    violations.push(...checkSkillText(text, label, kind));
  }
  return violations;
}

// ─── Fixture helper ──────────────────────────────────────────────────────────

/** Create a temp skills root with `<id>/SKILL.md` per entry, run the checker,
 *  always remove the root. Scratch disk is `tmpdir()`-derived (hygiene rule). */
async function withFixtureRoot(
  name: string,
  skills: Record<string, string>,
  fn: (violations: string[]) => Promise<void> | void,
  kind: SkillKind = "script",
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `vt-bs1-${name}-`));
  try {
    for (const [id, skillText] of Object.entries(skills)) {
      await mkdir(join(root, id), { recursive: true });
      await Bun.write(join(root, id, "SKILL.md"), skillText);
    }
    const violations = await checkSkillsRoot(root, kind);
    await fn(violations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const frontmatter = (id: string): string => `---
name: ${id}
description: Fixture skill for the achievability guard.
---
`;

// ─── Setup: derive every set the guard reads ────────────────────────────────

beforeAll(async () => {
  PROMPT_SURFACE = dumpPromptSurface();
  DICE_SURFACE = dumpDiceSurface();
  SURFACE_MEMBER_NAMES = surfaceMemberNames(PROMPT_SURFACE, DICE_SURFACE);

  // The script kind's FULL served set, from the real tool builder (a store
  // container is required by the builder's signature; nothing is executed).
  const stores = await createStoreContainer(":memory:");
  SCRIPT_SERVED_TOOLS = new Set(Object.keys(buildScriptAgentTools({ scriptId: "achievability-probe", codeTrusted: false, stores })));

  SCRIPT_BASE_VOCAB = snakeTokensOf(await Bun.file(join(API_ASSETS_DIR, getServicePromptAssetFile("script_agent_base"))).text());
  SIDECHAT_BASE_VOCAB = snakeTokensOf(await Bun.file(join(API_ASSETS_DIR, getServicePromptAssetFile("sidechat_ooc_base"))).text());
});

// ─── The guard ───────────────────────────────────────────────────────────────

describe("built-in skill achievability guard (BS-1)", () => {
  test("the derived surfaces and tool sets are live (anchored, non-empty)", () => {
    // If a derivation silently went empty the guard would either flag
    // everything or subtract everything — pin its anchors.
    for (const channel of ["chat", "character", "lore", "state", "shared", "persona"]) {
      expect(PROMPT_SURFACE[channel]).toBeDefined();
    }
    expect(pathInSurface(PROMPT_SURFACE, ["chat", "injectMessage"])).toBe(true);
    expect(pathInSurface(PROMPT_SURFACE, ["state", "increment"])).toBe(true);
    expect(DICE_SURFACE.dice).toBeDefined();
    expect(pathInSurface(DICE_SURFACE, ["dice", "register"])).toBe(true);
    expect(pathInSurface(DICE_SURFACE, ["dice", "roll"])).toBe(true);
    expect(pathInSurface(DICE_SURFACE, ["actor", "actorLabel"])).toBe(true);
    expect(SCRIPT_SERVED_TOOLS.size).toBeGreaterThan(0);
    for (const tool of ["write_buffer", "edit_buffer", "run_script_test", "ask_user", "read_skill_file"]) {
      expect(SCRIPT_SERVED_TOOLS.has(tool)).toBe(true);
    }
    expect(SIDECHAT_SERVED_TOOLS.has("search_context")).toBe(true);
    expect(SIDECHAT_SERVED_TOOLS.has("read_context_item")).toBe(true);
    expect(SURFACE_MEMBER_NAMES.has("last_message")).toBe(true);
    expect(SCRIPT_BASE_VOCAB.has("run_script_test")).toBe(true);
  });

  test("real built-in roots: every shipped skill is achievable (vacuous while the roots hold only READMEs)", async () => {
    // The roots must resolve to the SHIPPED assets directories — a resolver
    // rot that pointed elsewhere would scan nothing and pass silently.
    const scriptRoot = await resolveScriptAgentSkillsRoot();
    expect(scriptRoot.replace(/\\/g, "/")).toMatch(/assets\/agent-script\/skills$/);
    const sidechatRoot = await resolveSidechatSkillsRoot();
    expect(sidechatRoot.replace(/\\/g, "/")).toMatch(/assets\/agent-sidechat\/skills$/);

    expect(await checkSkillsRoot(scriptRoot, "script")).toEqual([]);
    expect(await checkSkillsRoot(sidechatRoot, "sidechat")).toEqual([]);
  });

  // ── Rule self-tests: one failing fixture per rule ──

  test("[example-runs] a broken ```js prompt example fails", async () => {
    await withFixtureRoot("broken-example", {
      "broken-example": `${frontmatter("broken-example")}
# Broken example

\`\`\`js prompt
const note = context.chat.lastMessage;
missingIdentifier.length;
\`\`\`
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[example-runs]");
      expect(violations[0]).toContain("broken-example/SKILL.md");
      expect(violations[0]).toContain("example block #1 failed in the real prompt sandbox");
    });
  });

  test("[example-runs] a broken ```js dice example fails", async () => {
    await withFixtureRoot("broken-dice", {
      "broken-dice": `${frontmatter("broken-dice")}
# Broken dice example

\`\`\`js dice
context.dice.register({
  id: "check",
  label: "Check",
  notation: "1d20",
  actors: ["persona"],
  resolution: "narrative",
  resolve() {
    return { boom: missingValue };
  },
});
\`\`\`
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[example-runs]");
      expect(violations[0]).toContain("broken-dice/SKILL.md");
      expect(violations[0]).toContain('check "check" failed its sample roll');
    });
  });

  test("[kind-tag] an untagged js block fails (the kind is mandatory)", async () => {
    await withFixtureRoot("untagged", {
      untagged: `${frontmatter("untagged")}
# Untagged block

\`\`\`js
context.state.set("x", 1);
\`\`\`
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[kind-tag]");
      expect(violations[0]).toContain("untagged/SKILL.md");
      expect(violations[0]).toContain("the kind is mandatory");
    });
  });

  test("[kind-tag] an unknown kind tag fails", async () => {
    await withFixtureRoot("unknown-kind", {
      "unknown-kind": `${frontmatter("unknown-kind")}
# Unknown kind tag

\`\`\`js hybrid
context.state.set("x", 1);
\`\`\`
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[kind-tag]");
      expect(violations[0]).toContain("unknown-kind/SKILL.md");
    });
  });

  test("[context-surface] a dice member in a prompt section fails naming the dice kind", async () => {
    await withFixtureRoot("wrong-kind-dice", {
      "wrong-kind-dice": `${frontmatter("wrong-kind-dice")}
## Prompt script route

The prompt script reads \`context.chat.lastMessage\` each turn. Do not reach for \`context.dice.register\` here.
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[context-surface]");
      expect(violations[0]).toContain("wrong-kind-dice/SKILL.md");
      expect(violations[0]).toContain("context.dice.register is a dice-kind member");
      expect(violations[0]).toContain("only in the dice sandbox");
    });
  });

  test("[context-surface] a prompt member in a dice section fails naming the prompt kind", async () => {
    await withFixtureRoot("wrong-kind-prompt", {
      "wrong-kind-prompt": `${frontmatter("wrong-kind-prompt")}
## Dice script route

Inside resolve() the check reads \`context.actor\`; the dice sandbox has no \`context.state.get\` channel.
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[context-surface]");
      expect(violations[0]).toContain("wrong-kind-prompt/SKILL.md");
      expect(violations[0]).toContain("context.state.get is a prompt-kind member");
      expect(violations[0]).toContain("only in the prompt sandbox");
    });
  });

  test("[context-surface] a non-existent deep member fails", async () => {
    await withFixtureRoot("deep-member", {
      "deep-member": `${frontmatter("deep-member")}
# Whispering back

The script can whisper back with \`context.chat.sendMessage("hi")\`.
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[context-surface]");
      expect(violations[0]).toContain("deep-member/SKILL.md");
      expect(violations[0]).toContain("context.chat.sendMessage does not exist in any script sandbox");
    });
  });

  test("[tool-mention] invented tools fail on the sidechat kind", async () => {
    await withFixtureRoot("invented-tools", {
      "invented-tools": `${frontmatter("invented-tools")}
# Research

Search the web with \`web_search\` before answering, and read lore with \`read_lorebook\`.
`,
    }, (violations) => {
      expect(violations.length).toBe(2);
      expect(violations[0]).toContain("[tool-mention]");
      expect(violations[0]).toContain("invented-tools/SKILL.md");
      expect(violations[0]).toContain("`web_search` is not a sidechat tool");
      expect(violations[0]).toContain("search_context");
      expect(violations[1]).toContain("`read_lorebook` is not a sidechat tool");
    }, "sidechat");
  });

  test("[tool-mention] a wrong-kind tool fails on the script kind", async () => {
    await withFixtureRoot("wrong-kind-tool", {
      "wrong-kind-tool": `${frontmatter("wrong-kind-tool")}
# Research

Call \`search_context\` to find the material first.
`,
    }, (violations) => {
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("[tool-mention]");
      expect(violations[0]).toContain("wrong-kind-tool/SKILL.md");
      expect(violations[0]).toContain("`search_context` is not a script-assistant tool");
      expect(violations[0]).toContain("run_script_test");
    });
  });

  test("[planned-surface] planned members never appear in a skill", async () => {
    await withFixtureRoot("planned-surface", {
      "planned-surface": `${frontmatter("planned-surface")}
# Networking

The script must never reach for \`context.net\` or \`context.memory\` — they are planned, not shipped.
`,
    }, (violations) => {
      expect(violations.length).toBe(2);
      expect(violations[0]).toContain("[planned-surface]");
      expect(violations[0]).toContain("planned-surface/SKILL.md");
      expect(violations[0]).toContain("context.net is a planned surface");
      expect(violations[1]).toContain("context.memory is a planned surface");
    });
  });

  test("[manifest] name ≠ folder and empty description fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "vt-bs1-manifest-"));
    try {
      await mkdir(join(root, "mismatched-name"), { recursive: true });
      await Bun.write(join(root, "mismatched-name", "SKILL.md"), `---
name: wrong-name
description: Fixture skill.
---
Body.
`);
      await mkdir(join(root, "no-description"), { recursive: true });
      await Bun.write(join(root, "no-description", "SKILL.md"), `---
name: no-description
---
Body.
`);
      const violations = await checkSkillsRoot(root, "script");
      expect(violations.length).toBe(2);
      expect(violations[0]).toContain("[manifest]");
      expect(violations[0]).toContain("mismatched-name/SKILL.md");
      expect(violations[0]).toContain('manifest name "wrong-name" does not match its folder id "mismatched-name"');
      expect(violations[1]).toContain("[manifest]");
      expect(violations[1]).toContain("no-description/SKILL.md");
      expect(violations[1]).toContain("description is empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── Positive controls: the guard passes the shapes Wave 2/3 will ship ──

  test("positive control: a valid script skill passes clean", async () => {
    await withFixtureRoot("good-script", {
      "good-script": `${frontmatter("good-script")}
# Good script skill

## Prompt script route

Read the last line with \`context.chat.lastMessage\`, count turns with \`context.chat.messageCount\`, and persist with \`context.state.increment\`.

\`\`\`js prompt
const turns = context.state.increment("turns", 1);
// A backticked token inside script code is a template literal (a state key),
// never a tool mention — the tool scan covers prose only.
context.shared.set(\`turn_\${turns}\`, true);
if (context.chat.messageCount > 2) {
  context.chat.injectMessage("[turn " + turns + "]");
}
\`\`\`

## Dice script route

\`\`\`js dice
context.dice.register({
  id: "check",
  label: "Check",
  notation: "1d20",
  actors: ["persona"],
  resolution: "narrative",
  resolve() {
    const r = context.dice.roll("1d20");
    return { faces: r.faces, modifier: 0, subtotal: r.subtotal, total: r.total };
  },
});
\`\`\`

Test the proposal with \`run_script_test\` before declaring it done.
`,
    }, (violations) => {
      expect(violations).toEqual([]);
    });
  });

  test("positive control: a valid sidechat skill passes clean", async () => {
    await withFixtureRoot("good-sidechat", {
      "good-sidechat": `${frontmatter("good-sidechat")}
# Good sidechat skill

Explain idioms from the recent \`<rp_sync>\` messages. Use \`search_context\` when the material is not attached; if the tool is off, ask the user to attach it with @.
`,
    }, (violations) => {
      expect(violations).toEqual([]);
    }, "sidechat");
  });
});
