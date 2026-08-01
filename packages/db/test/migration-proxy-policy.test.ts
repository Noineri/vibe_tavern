import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
}

async function buildPreProxyFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-proxy-policy-pre-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });

  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const proxyIndex = journal.entries.findIndex((entry) => entry.tag.startsWith("0029_"));
  if (proxyIndex === -1) throw new Error("Proxy migration 0029 is missing from the real migration journal");

  for (const entry of journal.entries.slice(proxyIndex)) {
    const prefix = entry.tag.slice(0, 4);
    await rm(join(folder, `${entry.tag}.sql`), { force: true });
    await rm(join(meta, `${prefix}_snapshot.json`), { force: true });
  }
  journal.entries = journal.entries.slice(0, proxyIndex);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

function foreignKeysOn(db: Database, table: string): ForeignKeyRow[] {
  return db.query(`PRAGMA foreign_key_list('${table}')`).all() as ForeignKeyRow[];
}

describe("0029/0030 proxy persistence migrations", () => {
  test("preserve providers and install proxy reference/policy constraints", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-proxy-policy-migration-"));
    const dbPath = join(work, "test.db");
    const preProxyFolder = await buildPreProxyFolder();

    let db = await createDb(dbPath, preProxyFolder);
    const preClient = (db as unknown as { $client: Database }).$client;
    preClient.exec(`
      INSERT INTO provider_profiles (
        id, name, provider_preset, endpoint, api_key, created_at, updated_at
      ) VALUES (
        'provider-existing', 'Existing', 'openai', 'https://example.test/v1', 'secret',
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      )
    `);
    preClient.close();

    db = await createDb(dbPath, REAL_DRIZZLE);
    const client = (db as unknown as { $client: Database }).$client;

    const provider = client.query(`
      SELECT name, endpoint, api_key, proxy_mode, proxy_id
      FROM provider_profiles WHERE id = 'provider-existing'
    `).get() as {
      name: string;
      endpoint: string;
      api_key: string | null;
      proxy_mode: string;
      proxy_id: string | null;
    };
    expect(provider).toEqual({
      name: "Existing",
      endpoint: "https://example.test/v1",
      api_key: "secret",
      proxy_mode: "inherit",
      proxy_id: null,
    });

    expect(foreignKeysOn(client, "provider_profiles").some((fk) => (
      fk.from === "proxy_id" && fk.table === "proxy_profiles" && fk.to === "id"
    ))).toBe(true);
    expect(foreignKeysOn(client, "proxy_settings").some((fk) => (
      fk.from === "default_proxy_id" && fk.table === "proxy_profiles" && fk.to === "id"
    ))).toBe(true);

    client.exec(`
      INSERT INTO proxy_profiles (id, name, url, sort_order, created_at, updated_at)
      VALUES ('proxy-1', 'Proxy', 'http://proxy.test:8080', 0, '2026-08-02', '2026-08-02')
    `);
    expect(() => client.exec(`
      UPDATE provider_profiles SET proxy_mode = 'proxy', proxy_id = 'proxy-1'
      WHERE id = 'provider-existing'
    `)).not.toThrow();
    expect(() => client.exec(`
      UPDATE provider_profiles SET proxy_mode = 'direct'
      WHERE id = 'provider-existing'
    `)).toThrow();
    expect(() => client.exec(`
      INSERT INTO proxy_settings (id, default_proxy_id, updated_at)
      VALUES ('not-default', 'proxy-1', '2026-08-02')
    `)).toThrow();

    client.close();
  });
});
