import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";
import { createDb } from "../src/db-connection.js";
import { agentReviewRounds, experienceCopilotThreads, characters, chats } from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { AgentReviewRoundStore } from "../src/stores/agent-review-round-store.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";

function envelope(proposed = "New rules") {
  return JSON.stringify({
    _v: 2,
    activities: [{ toolCallId: "write", toolName: "write_buffer", status: "done", target: "rules", proposed, args: { content: proposed } }],
    round: {
      snapshots: [{ id: 1, rules: "Old rules", visual: "<main>Old</main>" }], nextSnapshotId: 2,
      acceptedRules: [0, -1], acceptedVisual: [], dismissedRules: [1], dismissedVisual: [2],
      rulesKey: `Old rules\0${proposed}`, visualKey: null,
      dangling: { visual: "Pending visual", baseRules: "Old rules", baseVisual: "<main>Old</main>" },
    },
  });
}
async function setup(realMigrations = false) {
  const db = await createDb(":memory:", undefined, { realMigrations });
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 29) + tick++ * 1000).toISOString() };
  const store = new AgentReviewRoundStore(db, { clock });
  const threads = new ExperienceCopilotStore(db);
  const thread = await threads.startNewSession("review_script", "Review session");
  return { db, store, threads, thread };
}

describe("AgentReviewRoundStore", () => {
  async function chatOwner(db: Awaited<ReturnType<typeof createDb>>) {
    const now = "2026-10-30T00:00:00.000Z";
    await db.insert(characters).values({ id: "review_character", name: "Review", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
    return new ChatStore(db).createChat({ characterId: "review_character", title: "Coauthor review", mode: "coauthor", promptPresetId: null });
  }

  test("chat reviews replace atomically and remain independent of thread rows and deletes", async () => {
    const { db, store, thread } = await setup();
    const chat = await chatOwner(db);
    await store.put(thread.id, envelope());
    await store.putChat(chat.id, '{"_v":1,"activities":[]}');
    await store.putChat(chat.id, '{"_v":1,"activities":[{"proposed":"New"}]}');
    expect(await store.getChat(chat.id)).toEqual({ chatId: chat.id, envelopeJson: '{"_v":1,"activities":[{"proposed":"New"}]}', updatedAt: "2026-10-29T00:00:02.000Z" });
    expect((await store.get(thread.id))!.envelopeJson).toBe(envelope());
    expect(await db.select().from(agentReviewRounds).all()).toHaveLength(2);
    await store.delete(chat.id);
    expect(await store.getChat(chat.id)).not.toBeNull();
    await store.deleteChat(thread.id);
    expect(await store.get(thread.id)).not.toBeNull();
    await store.deleteChat(chat.id);
    await store.deleteChat(chat.id);
    expect(await store.getChat(chat.id)).toBeNull();
    expect(await store.get(thread.id)).not.toBeNull();
  });

  test("database CHECK rejects both/neither owner; chat FK and uniqueness remain enforced", async () => {
    const { db, store, thread } = await setup();
    const chat = await chatOwner(db);
    const row = { envelopeJson: "{}", updatedAt: "now" };
    expect(() => db.insert(agentReviewRounds).values(row).run()).toThrow();
    expect(() => db.insert(agentReviewRounds).values({ ...row, threadId: thread.id, chatId: chat.id }).run()).toThrow();
    await expect(store.putChat("missing", "{}")).rejects.toThrow();
    await store.putChat(chat.id, "{}");
    expect(() => db.insert(agentReviewRounds).values({ ...row, chatId: chat.id }).run()).toThrow();
    await store.put(thread.id, envelope());
    await db.delete(chats).where(eq(chats.id, chat.id)).run();
    expect(await store.getChat(chat.id)).toBeNull();
    expect(await store.get(thread.id)).not.toBeNull();
  });

  test("the actual rebuild SQL preserves pre-BR-4b thread review bytes and timestamps", async () => {
    const { db, store, thread } = await setup(true);
    await db.run(sql`DROP TABLE agent_review_rounds`);
    await db.run(sql`CREATE TABLE agent_review_rounds (thread_id text PRIMARY KEY NOT NULL REFERENCES experience_copilot_threads(id) ON DELETE CASCADE, envelope_json text NOT NULL, updated_at text NOT NULL)`);
    const json = envelope();
    await db.run(sql`INSERT INTO agent_review_rounds VALUES (${thread.id}, ${json}, 'before-upgrade')`);
    const migration = await Bun.file(join(import.meta.dir, "../drizzle/0131_giant_namora.sql")).text();
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db.run(sql.raw(statement));
    expect(await store.get(thread.id)).toEqual({ threadId: thread.id, envelopeJson: json, updatedAt: "before-upgrade" });
    const chat = await chatOwner(db);
    await store.putChat(chat.id, "{}");
    expect(await store.getChat(chat.id)).not.toBeNull();
    await db.delete(experienceCopilotThreads).where(eq(experienceCopilotThreads.id, thread.id)).run();
    expect(await store.get(thread.id)).toBeNull();
    expect(await store.getChat(chat.id)).not.toBeNull();
  });
  test("the real migration creates an empty table and the complete envelope round-trips", async () => {
    const { db, store, thread } = await setup(true);
    expect(await db.select().from(agentReviewRounds).all()).toEqual([]);
    expect(await store.get(thread.id)).toBeNull();
    const json = envelope();
    await store.put(thread.id, json);
    const row = await store.get(thread.id);
    expect(row).toEqual({ threadId: thread.id, envelopeJson: json, updatedAt: "2026-10-29T00:00:00.000Z" });
    expect(JSON.parse(row!.envelopeJson)).toEqual(JSON.parse(json));
  });

  test("put fully replaces the envelope and updates the injected timestamp, never adding a row", async () => {
    const { db, store, thread } = await setup();
    await store.put(thread.id, envelope());
    const before = await store.get(thread.id);
    const replacement = envelope("Revised rules");
    await store.put(thread.id, replacement);
    expect(await store.get(thread.id)).toEqual({ threadId: thread.id, envelopeJson: replacement, updatedAt: "2026-10-29T00:00:01.000Z" });
    expect((await store.get(thread.id))!.updatedAt > before!.updatedAt).toBe(true);
    expect(await db.select().from(agentReviewRounds).all()).toHaveLength(1);
  });

  test("the database rejects a second row for the same thread even outside the store", async () => {
    const { db, store, thread } = await setup();
    await store.put(thread.id, envelope());
    expect(() => db.insert(agentReviewRounds).values({ threadId: thread.id, envelopeJson: envelope("Duplicate"), updatedAt: "2026-10-29" }).run()).toThrow();
    expect((await store.get(thread.id))!.envelopeJson).toBe(envelope());
  });

  test("deleting a thread cascades its review without affecting another thread", async () => {
    const { db, store, threads, thread } = await setup();
    const other = await threads.startNewSession("other_script", "Other");
    await store.put(thread.id, envelope());
    await store.put(other.id, envelope("Other rules"));
    await db.delete(experienceCopilotThreads).where(eq(experienceCopilotThreads.id, thread.id)).run();
    expect(await store.get(thread.id)).toBeNull();
    expect((await store.get(other.id))!.envelopeJson).toBe(envelope("Other rules"));
    expect(await db.select().from(agentReviewRounds).all()).toHaveLength(1);
  });

  test("a nonexistent thread cannot own a review", async () => {
    const { db, store } = await setup();
    await expect(store.put("missing_thread", envelope())).rejects.toThrow();
    expect(await store.get("missing_thread")).toBeNull();
    expect(await db.select().from(agentReviewRounds).all()).toEqual([]);
  });

  test("delete is idempotent and only removes the requested thread's review", async () => {
    const { store, threads, thread } = await setup();
    const other = await threads.startNewSession("other_script", "Other");
    await store.put(thread.id, envelope());
    await store.put(other.id, envelope("Other rules"));
    await store.delete(thread.id);
    await store.delete(thread.id);
    await store.delete("missing_thread");
    expect(await store.get(thread.id)).toBeNull();
    expect((await store.get(other.id))!.envelopeJson).toBe(envelope("Other rules"));
    expect(await threads.getById(thread.id)).not.toBeNull();
  });

  test("archiving a session retains its review and a new session starts without one", async () => {
    const { store, threads, thread } = await setup();
    await store.put(thread.id, envelope());
    const next = await threads.startNewSession("review_script", "Next session");
    expect((await threads.getById(thread.id))!.archivedAt).not.toBeNull();
    expect((await store.get(thread.id))!.envelopeJson).toBe(envelope());
    expect(await store.get(next.id)).toBeNull();
  });
});
