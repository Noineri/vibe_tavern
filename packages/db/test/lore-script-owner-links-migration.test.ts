// Unit 14 (LORE_SCRIPT_OWNERS_AS_LINKS_REPORT step 1) — the owners-as-links
// migration (0107) must change NOTHING about which lorebooks and scripts
// participate in any chat. This fixture test proves it end to end on the SAME
// database file: build at journal state 0106 (the last schema that still has
// the home-owner FK columns), seed the report's fixture matrix (home-only,
// link-only, home+links, persona-home, chat-scoped, global — plus disabled,
// stale-home and already-dedup variants), derive the expected participation
// from the fixture table itself (transcribing the pre-migration binding rule),
// then let createDb apply the full journal — 0107 copies every entity-scoped
// home into its link table and drops the FK columns — and finally re-read the
// SAME participation through the real stores.
//
// Why the expectations are derived from the fixture table and not from a
// pre-migration store read: the committed store code IS the post-migration
// code (links-only). A store read on the 0106 database would silently drop
// home-only rows and "pass" against itself. The TS derivation below is the
// characterization pin of the pre-0107 rule
// (lorebook-chat-resolution.ts + ScriptStore.resolveChatScriptBindings at
// c6682afd): global pool ∪ entity-FK homes ∪ links ∪ chat FK, most-specific
// binding kind chat > persona > character > global, enabled-only for the
// pipeline read, attached-disabled for «Текущие».
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import { createDb, type AppDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const REAL_DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");
const PRE_0107_LAST_TAG = "0106_parallel_lucky_pierre";

const clock: StoreClock = { now: () => "2026-10-04T00:00:00.000Z" };
const idGen: StoreIdGenerator = { next: (p) => `${p}_owners_${Math.random().toString(36).slice(2, 8)}` };

// ─── Fixture matrix (the report's step-1 list + guards) ──────────────────────

type TargetType = "character" | "persona";
interface LinkFixture { type: TargetType; id: string }
interface OwnerFixture {
  id: string;
  kind: "lorebook" | "script";
  scope: "global" | "entity" | "chat";
  home?: LinkFixture;
  links: LinkFixture[];
  chat?: string;
  enabled: boolean;
  scriptKind?: "prompt" | "dice";
}

const CHAR_A = "char_A";
const CHAR_B = "char_B";
const PERSONA_P = "persona_P";
const PERSONA_Q = "persona_Q";
const CHAT_1 = "chat_1";
const CHAT_2 = "chat_2";
const CHAT_3 = "chat_3";

const FIXTURES: OwnerFixture[] = [
  // ── Lorebooks ──
  { id: "lb_home_char", kind: "lorebook", scope: "entity", home: { type: "character", id: CHAR_A }, links: [], enabled: true },
  { id: "lb_home_persona", kind: "lorebook", scope: "entity", home: { type: "persona", id: PERSONA_P }, links: [], enabled: true },
  { id: "lb_link_only", kind: "lorebook", scope: "entity", links: [{ type: "character", id: CHAR_B }], enabled: true },
  { id: "lb_home_and_links", kind: "lorebook", scope: "entity", home: { type: "character", id: CHAR_A }, links: [{ type: "persona", id: PERSONA_Q }], enabled: true },
  { id: "lb_chat", kind: "lorebook", scope: "chat", chat: CHAT_1, links: [], enabled: true },
  { id: "lb_global", kind: "lorebook", scope: "global", links: [], enabled: true },
  // Home + an ALREADY PRESENT identical link — the migration must not
  // duplicate it (composite PK) and participation must stay single.
  { id: "lb_home_dup_link", kind: "lorebook", scope: "entity", home: { type: "character", id: CHAR_A }, links: [{ type: "character", id: CHAR_A }], enabled: true },
  // Disabled home-only book: never in the pipeline read (enabled-only), but
  // attached («Текущие») via its entity binding.
  { id: "lb_home_disabled", kind: "lorebook", scope: "entity", home: { type: "character", id: CHAR_A }, links: [], enabled: false },
  // Disabled global: in neither read (participates only through the global
  // pool, which requires enabled).
  { id: "lb_global_disabled", kind: "lorebook", scope: "global", links: [], enabled: false },
  // Stale home on a NON-entity row (the accordion scope-flip residue): the
  // pre-0107 resolver required scope_type='entity' for the home FK to fire, so
  // this book participates globally only — 0107 must NOT copy this home into a
  // link (that would create participation that never existed).
  { id: "lb_stale_home_global", kind: "lorebook", scope: "global", home: { type: "character", id: CHAR_A }, links: [], enabled: true },
  // ── Scripts (same matrix; one dice home pins the kind split) ──
  { id: "sc_home_char", kind: "script", scope: "entity", home: { type: "character", id: CHAR_A }, links: [], enabled: true, scriptKind: "dice" },
  { id: "sc_home_persona", kind: "script", scope: "entity", home: { type: "persona", id: PERSONA_P }, links: [], enabled: true },
  { id: "sc_link_only", kind: "script", scope: "entity", links: [{ type: "character", id: CHAR_B }], enabled: true },
  { id: "sc_home_and_links", kind: "script", scope: "entity", home: { type: "character", id: CHAR_A }, links: [{ type: "persona", id: PERSONA_Q }], enabled: true },
  { id: "sc_chat", kind: "script", scope: "chat", chat: CHAT_2, links: [], enabled: true },
  { id: "sc_global", kind: "script", scope: "global", links: [], enabled: true },
  { id: "sc_home_dup_link", kind: "script", scope: "entity", home: { type: "character", id: CHAR_A }, links: [{ type: "character", id: CHAR_A }], enabled: true },
  { id: "sc_home_disabled", kind: "script", scope: "entity", home: { type: "persona", id: PERSONA_P }, links: [], enabled: false },
  { id: "sc_global_disabled", kind: "script", scope: "global", links: [], enabled: false },
  { id: "sc_stale_home_global", kind: "script", scope: "global", home: { type: "character", id: CHAR_A }, links: [], enabled: true },
];

interface ChatContext { characterId: string; personaId: string | null; chatId: string }
const CONTEXTS: ChatContext[] = [
  { characterId: CHAR_A, personaId: PERSONA_P, chatId: CHAT_1 },
  { characterId: CHAR_B, personaId: PERSONA_Q, chatId: CHAT_2 },
  { characterId: CHAR_A, personaId: null, chatId: CHAT_3 },
];

// ─── Pre-0107 rule, transcribed over the fixture table ──────────────────────

function bindingKinds(f: OwnerFixture, ctx: ChatContext): Set<"chat" | "persona" | "character" | "global"> {
  const kinds = new Set<"chat" | "persona" | "character" | "global">();
  if (f.scope === "global") kinds.add("global");
  // Entity-FK home: fires only for entity-scoped rows, against the matching
  // owner column (character home ↔ ctx.characterId, persona home ↔ ctx.personaId).
  if (f.scope === "entity" && f.home) {
    if (f.home.type === "character" && f.home.id === ctx.characterId) kinds.add("character");
    if (f.home.type === "persona" && ctx.personaId !== null && f.home.id === ctx.personaId) kinds.add("persona");
  }
  // Links: character links always consulted; persona links only when the chat
  // HAS a persona (mirrors the resolver's `if (personaId)` guard).
  for (const link of f.links) {
    if (link.type === "character" && link.id === ctx.characterId) kinds.add("character");
    if (link.type === "persona" && ctx.personaId !== null && link.id === ctx.personaId) kinds.add("persona");
  }
  // Chat branch — transcribed PER RESOLVER, because the two differ today:
  //  - lorebooks require scope='chat' AND chat_id = ctx (the AND pair);
  //  - scripts OR the two predicates (`or(eq(scopeType,'chat'), eq(chatId, ctx))`
  //    in resolveChatScriptBindings), so EVERY chat-scoped script binds every
  //    chat. Quirky, but unit 14 leaves the chat branch untouched — pinned
  //    as-is so the before/after proof covers the real rule.
  if (f.kind === "lorebook") {
    if (f.scope === "chat" && f.chat === ctx.chatId) kinds.add("chat");
  } else {
    if (f.scope === "chat" || f.chat === ctx.chatId) kinds.add("chat");
  }
  return kinds;
}

function mostSpecificKind(kinds: Set<"chat" | "persona" | "character" | "global">): "chat" | "persona" | "character" | "global" {
  if (kinds.has("chat")) return "chat";
  if (kinds.has("persona")) return "persona";
  if (kinds.has("character")) return "character";
  return "global";
}

function entityBound(kinds: Set<"chat" | "persona" | "character" | "global">): boolean {
  return kinds.has("chat") || kinds.has("persona") || kinds.has("character");
}

interface ExpectedParticipation {
  pipelineLorebooks: string[];            // enabled-only activation read
  participatingLorebooks: string[];       // attached-disabled kept
  lorebookKinds: Record<string, string>;  // most-specific kind per bound book
  promptScripts: string[];
  diceScripts: string[];
  participatingScripts: string[];
}

function expectedFor(ctx: ChatContext): ExpectedParticipation {
  return deriveExpected(FIXTURES, ctx);
}

function deriveExpected(fixtures: OwnerFixture[], ctx: ChatContext): ExpectedParticipation {
  const lorebookKinds: Record<string, string> = {};
  const pipelineLorebooks: string[] = [];
  const participatingLorebooks: string[] = [];
  const promptScripts: string[] = [];
  const diceScripts: string[] = [];
  const participatingScripts: string[] = [];
  for (const f of fixtures) {
    const kinds = bindingKinds(f, ctx);
    if (kinds.size === 0) continue;
    const bound = entityBound(kinds);
    if (f.kind === "lorebook") {
      lorebookKinds[f.id] = mostSpecificKind(kinds);
      if (f.enabled) pipelineLorebooks.push(f.id);
      if (f.enabled || bound) participatingLorebooks.push(f.id);
    } else {
      const kind = f.scriptKind ?? "prompt";
      if (kind !== "interactive") {
        if (f.enabled || bound) participatingScripts.push(f.id);
      }
      if (f.enabled && kind === "prompt") promptScripts.push(f.id);
      if (f.enabled && kind === "dice") diceScripts.push(f.id);
    }
  }
  return { pipelineLorebooks, participatingLorebooks, lorebookKinds, promptScripts, diceScripts, participatingScripts };
}

/** The link set each fixture must carry AFTER the migration (homes of entity rows copied, deduped; stale homes dropped). */
function expectedPostMigrationLinks(): Record<string, Array<{ type: TargetType; id: string }>> {
  const out: Record<string, Array<{ type: TargetType; id: string }>> = {};
  for (const f of FIXTURES) {
    const links = f.links.map((l) => ({ type: l.type, id: l.id }));
    if (f.scope === "entity" && f.home && !links.some((l) => l.type === f.home!.type && l.id === f.home!.id)) {
      links.push({ type: f.home.type, id: f.home.id });
    }
    out[f.id] = links;
  }
  return out;
}

// ─── Phase A/B: build the pre-0107 database and seed it ──────────────────────

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

async function buildPreMigrationFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-owners-links-"));
  const folder = join(dir, "drizzle");
  await mkdir(folder);
  const journal = JSON.parse(await readFile(resolve(REAL_DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const cut = journal.entries.findIndex((e) => e.tag === PRE_0107_LAST_TAG);
  if (cut < 0) throw new Error(`journal does not contain ${PRE_0107_LAST_TAG} — update PRE_0107_LAST_TAG for the new baseline`);
  const kept = journal.entries.slice(0, cut + 1);
  for (const entry of kept) {
    const sql = await readFile(resolve(REAL_DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await Bun.write(resolve(folder, `${entry.tag}.sql`), sql);
  }
  await mkdir(resolve(folder, "meta"), { recursive: true });
  await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

async function seedPreMigrationDatabase(db: AppDb): Promise<void> {
  await db.run(`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('${CHAR_A}', 'Alice', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('${CHAR_B}', 'Bob', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('${PERSONA_P}', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('${PERSONA_Q}', 'Q', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO chats (id, character_id, persona_id, active_branch_id, title, created_at, updated_at) VALUES ('${CHAT_1}', '${CHAR_A}', '${PERSONA_P}', 'b1', 'T1', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO chats (id, character_id, persona_id, active_branch_id, title, created_at, updated_at) VALUES ('${CHAT_2}', '${CHAR_B}', '${PERSONA_Q}', 'b2', 'T2', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO chats (id, character_id, persona_id, active_branch_id, title, created_at, updated_at) VALUES ('${CHAT_3}', '${CHAR_A}', NULL, 'b3', 'T3', '2026-01-01', '2026-01-01')`);

  for (const f of FIXTURES) {
    const homeChar = f.home?.type === "character" ? f.home.id : null;
    const homePersona = f.home?.type === "persona" ? f.home.id : null;
    if (f.kind === "lorebook") {
      await db.run(
        `INSERT INTO lorebooks (id, name, scope_type, character_id, persona_id, chat_id, enabled, created_at, updated_at) VALUES ('${f.id}', '${f.id}', '${f.scope}', ${homeChar ? `'${homeChar}'` : "NULL"}, ${homePersona ? `'${homePersona}'` : "NULL"}, ${f.chat ? `'${f.chat}'` : "NULL"}, ${f.enabled ? 1 : 0}, '2026-01-01', '2026-01-01')`,
      );
    } else {
      await db.run(
        `INSERT INTO scripts (id, name, scope_type, character_id, persona_id, chat_id, enabled, script_kind, created_at, updated_at) VALUES ('${f.id}', '${f.id}', '${f.scope}', ${homeChar ? `'${homeChar}'` : "NULL"}, ${homePersona ? `'${homePersona}'` : "NULL"}, ${f.chat ? `'${f.chat}'` : "NULL"}, ${f.enabled ? 1 : 0}, '${f.scriptKind ?? "prompt"}', '2026-01-01', '2026-01-01')`,
      );
    }
    for (const link of f.links) {
      const table = f.kind === "lorebook" ? "lorebook_links" : "script_links";
      const idCol = f.kind === "lorebook" ? "lorebook_id" : "script_id";
      await db.run(`INSERT INTO ${table} (${idCol}, target_type, target_id) VALUES ('${f.id}', '${link.type}', '${link.id}')`);
    }
  }
}

function readStores(db: AppDb): { lorebooks: LorebookStore; scripts: ScriptStore } {
  return {
    lorebooks: new LorebookStore(db, { clock, idGenerator: idGen, content: null }),
    scripts: new ScriptStore(db, { clock, idGenerator: idGen, content: null }),
  };
}

async function assertParticipation(stores: { lorebooks: LorebookStore; scripts: ScriptStore }, ctx: ChatContext, label: string): Promise<void> {
  const expected = expectedFor(ctx);

  const pipeline = await stores.lorebooks.listAllActiveForChat(ctx.characterId, ctx.personaId, ctx.chatId);
  expect([...pipeline.map((a) => a.lorebook.id)].sort(), `${label}: pipeline lorebook set`).toEqual([...expected.pipelineLorebooks].sort());
  for (const active of pipeline) {
    expect(active.bindingKind, `${label}: kind of ${active.lorebook.id}`).toBe(expected.lorebookKinds[active.lorebook.id]);
  }

  const participatingBooks = await stores.lorebooks.listParticipatingForChat(ctx.characterId, ctx.personaId, ctx.chatId);
  expect([...participatingBooks.map((lb) => lb.id)].sort(), `${label}: participating lorebook set`).toEqual([...expected.participatingLorebooks].sort());

  const prompt = await stores.scripts.listAllEnabledForChat(ctx.characterId, ctx.personaId, ctx.chatId);
  expect([...prompt.map((s) => s.id)].sort(), `${label}: prompt script set`).toEqual([...expected.promptScripts].sort());
  const dice = await stores.scripts.listAllEnabledDiceScriptsForChat(ctx.characterId, ctx.personaId, ctx.chatId);
  expect([...dice.map((s) => s.id)].sort(), `${label}: dice script set`).toEqual([...expected.diceScripts].sort());
  const participatingScripts = await stores.scripts.listParticipatingForChat(ctx.characterId, ctx.personaId, ctx.chatId);
  expect([...participatingScripts.map((s) => s.id)].sort(), `${label}: participating script set`).toEqual([...expected.participatingScripts].sort());
}

function columnsOf(db: AppDb, table: string): string[] {
  const rows = db.all(`PRAGMA table_info(${table})`) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Read the seeded rows back as fixtures (homes + links) so the pre-migration
 *  derivation runs over the ACTUAL database state, not the static fixture
 *  list — proving the seed and the derivation agree row by row. */
async function readDbFixtures(db: AppDb): Promise<OwnerFixture[]> {
  const out: OwnerFixture[] = [];
  type Row = { id: string; scope_type: string; character_id: string | null; persona_id: string | null; chat_id: string | null; enabled: number };
  const lbRows = db.all("SELECT id, scope_type, character_id, persona_id, chat_id, enabled FROM lorebooks") as unknown as Row[];
  const lbLinks = db.all("SELECT lorebook_id, target_type, target_id FROM lorebook_links") as unknown as Array<{ lorebook_id: string; target_type: string; target_id: string }>;
  for (const r of lbRows) {
    out.push({
      id: r.id,
      kind: "lorebook",
      scope: r.scope_type as OwnerFixture["scope"],
      home: r.character_id ? { type: "character", id: r.character_id } : r.persona_id ? { type: "persona", id: r.persona_id } : undefined,
      links: lbLinks.filter((l) => l.lorebook_id === r.id).map((l) => ({ type: l.target_type as TargetType, id: l.target_id })),
      chat: r.chat_id ?? undefined,
      enabled: r.enabled === 1,
    });
  }
  type ScRow = Row & { script_kind: string };
  const scRows = db.all("SELECT id, scope_type, character_id, persona_id, chat_id, enabled, script_kind FROM scripts") as unknown as ScRow[];
  const scLinks = db.all("SELECT script_id, target_type, target_id FROM script_links") as unknown as Array<{ script_id: string; target_type: string; target_id: string }>;
  for (const r of scRows) {
    out.push({
      id: r.id,
      kind: "script",
      scope: r.scope_type as OwnerFixture["scope"],
      home: r.character_id ? { type: "character", id: r.character_id } : r.persona_id ? { type: "persona", id: r.persona_id } : undefined,
      links: scLinks.filter((l) => l.script_id === r.id).map((l) => ({ type: l.target_type as TargetType, id: l.target_id })),
      chat: r.chat_id ?? undefined,
      enabled: r.enabled === 1,
      scriptKind: r.script_kind as "prompt" | "dice",
    });
  }
  return out;
}

// ─── The test ────────────────────────────────────────────────────────────────

describe("migration 0107 — owners become links, participation identical", () => {
  test("every chat's participating lorebooks/scripts are identical before and after; homes copied exactly once; columns dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-owners-mig-"));
    const dbPath = join(dir, "test.db");

    // Phase A: schema at 0106 — home-owner columns exist.
    const preFolder = await buildPreMigrationFolder();
    const preDb = await createDb(dbPath, preFolder);
    expect(columnsOf(preDb, "lorebooks")).toContain("character_id");
    expect(columnsOf(preDb, "lorebooks")).toContain("persona_id");
    expect(columnsOf(preDb, "scripts")).toContain("character_id");
    expect(columnsOf(preDb, "scripts")).toContain("persona_id");

    // Phase B: seed the fixture matrix (raw SQL — the store no longer writes homes).
    await seedPreMigrationDatabase(preDb);

    // Phase C: pin today's participation ON THE SEEDED DATA. The pre-0107
    // resolver is gone from the committed code, so the before-read derives the
    // pre-migration rule over the ACTUAL rows read back from the 0106 database
    // (`readDbFixtures` + `deriveExpected`) and must equal the static fixture
    // derivation exactly. (The derivation itself was validated against the
    // LIVE pre-change stores at c6682afd — same fixtures, all three contexts,
    // 35 assertions green — before any store code was modified.)
    const dbFixtures = await readDbFixtures(preDb);
    expect(dbFixtures.map((f) => f.id).sort()).toEqual(FIXTURES.map((f) => f.id).sort());
    for (const ctx of CONTEXTS) {
      const fromDb = deriveExpected(dbFixtures, ctx);
      const expected = expectedFor(ctx);
      expect([...fromDb.pipelineLorebooks].sort(), `pre-migration ${ctx.chatId}: pipeline lorebook set`).toEqual([...expected.pipelineLorebooks].sort());
      expect([...fromDb.participatingLorebooks].sort(), `pre-migration ${ctx.chatId}: participating lorebook set`).toEqual([...expected.participatingLorebooks].sort());
      expect([...fromDb.promptScripts].sort(), `pre-migration ${ctx.chatId}: prompt script set`).toEqual([...expected.promptScripts].sort());
      expect([...fromDb.diceScripts].sort(), `pre-migration ${ctx.chatId}: dice script set`).toEqual([...expected.diceScripts].sort());
      expect([...fromDb.participatingScripts].sort(), `pre-migration ${ctx.chatId}: participating script set`).toEqual([...expected.participatingScripts].sort());
    }
    (preDb as unknown as { $client: Database }).$client.close();

    // Phase D: apply the full journal (0107) on the SAME database file via the
    // real createDb path — the exact upgrade a user's database goes through.
    const postDb = await createDb(dbPath);
    expect(columnsOf(postDb, "lorebooks")).not.toContain("character_id");
    expect(columnsOf(postDb, "lorebooks")).not.toContain("persona_id");
    expect(columnsOf(postDb, "scripts")).not.toContain("character_id");
    expect(columnsOf(postDb, "scripts")).not.toContain("persona_id");

    // Every entity-scoped home became a link (deduped); non-entity homes were
    // NOT copied (they never participated); original links survive verbatim.
    const expectedLinks = expectedPostMigrationLinks();
    const lbLinks = postDb.all("SELECT lorebook_id, target_type, target_id FROM lorebook_links ORDER BY lorebook_id, target_type, target_id") as unknown as Array<Record<string, string>>;
    const scLinks = postDb.all("SELECT script_id, target_type, target_id FROM script_links ORDER BY script_id, target_type, target_id") as unknown as Array<Record<string, string>>;
    const lbExpected = FIXTURES.filter((f) => f.kind === "lorebook").flatMap((f) => expectedLinks[f.id].map((l) => ({ lorebook_id: f.id, target_type: l.type, target_id: l.id })));
    const scExpected = FIXTURES.filter((f) => f.kind === "script").flatMap((f) => expectedLinks[f.id].map((l) => ({ script_id: f.id, target_type: l.type, target_id: l.id })));
    expect(lbLinks).toEqual(lbExpected.sort((a, b) => `${a.lorebook_id}${a.target_type}${a.target_id}`.localeCompare(`${b.lorebook_id}${b.target_type}${b.target_id}`)));
    expect(scLinks).toEqual(scExpected.sort((a, b) => `${a.script_id}${a.target_type}${a.target_id}`.localeCompare(`${b.script_id}${b.target_type}${b.target_id}`)));

    // Phase E: the SAME participation through the post-migration stores.
    const postStores = readStores(postDb);
    for (const ctx of CONTEXTS) {
      await assertParticipation(postStores, ctx, `post-migration ${ctx.chatId}`);
    }

    // No fixture row was lost.
    expect((postDb.all("SELECT COUNT(*) n FROM lorebooks") as unknown as Array<{ n: number }>)[0].n).toBe(FIXTURES.filter((f) => f.kind === "lorebook").length);
    expect((postDb.all("SELECT COUNT(*) n FROM scripts") as unknown as Array<{ n: number }>)[0].n).toBe(FIXTURES.filter((f) => f.kind === "script").length);
  });
});
