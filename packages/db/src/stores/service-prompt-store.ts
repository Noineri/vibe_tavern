import { asc, desc, eq } from 'drizzle-orm';

import { brandId } from '@vibe-tavern/domain';
import type { ServicePromptProfileId, ServicePromptFieldKey } from '@vibe-tavern/domain';
import { SERVICE_PROMPT_FIELD_KEYS } from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { servicePromptProfiles } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export type CreateServicePromptProfileData = {
  name: string;
  overrides?: ServicePromptOverridesInput;
};

export type UpdateServicePromptProfileData = {
  name?: string;
  overrides?: ServicePromptOverridesInput;
};

/** Overrides input at the store boundary: keyed by the domain field union
 *  (unknown keys are dropped by serializeOverrides). Optional values mirror
 *  the contracts' `ServicePromptOverrides` shape so the API adapter can pass
 *  request bodies through without casts. */
export type ServicePromptOverridesInput = Partial<Record<ServicePromptFieldKey, string>>;

export interface ServicePromptProfile {
  id: ServicePromptProfileId;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  overrides: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_KEYS = new Set<string>(SERVICE_PROMPT_FIELD_KEYS as readonly string[]);

function parseOverrides(raw: string): Record<string, string> {
  try {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      if (typeof v !== 'string') continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function serializeOverrides(overrides: ServicePromptOverridesInput): string {
  // Validate again before write — drop unknown / non-string keys.
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    filtered[k] = v;
  }
  return JSON.stringify(filtered);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ServicePromptProfileStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async listServicePromptProfiles(): Promise<ServicePromptProfile[]> {
    await this.ensureDefaultServicePromptProfile();
    const rows = await this.db
      .select()
      .from(servicePromptProfiles)
      .orderBy(desc(servicePromptProfiles.isDefault), asc(servicePromptProfiles.sortOrder), asc(servicePromptProfiles.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getServicePromptProfile(id: string): Promise<ServicePromptProfile | null> {
    await this.ensureDefaultServicePromptProfile();
    const row = await this.db
      .select()
      .from(servicePromptProfiles)
      .where(eq(servicePromptProfiles.id, id))
      .get();
    return row ? this.mapRow(row) : null;
  }

  async ensureDefaultServicePromptProfile(): Promise<ServicePromptProfile> {
    const existing = await this.db
      .select()
      .from(servicePromptProfiles)
      .where(eq(servicePromptProfiles.id, 'default'))
      .get();
    if (existing) return this.mapRow(existing);

    const now = this.clock.now();
    const [row] = await this.db
      .insert(servicePromptProfiles)
      .values({
        id: 'default',
        name: 'Default',
        isDefault: 1,
        overrides: '{}',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return this.mapRow(row);

    // Race: another caller inserted concurrently.
    const raced = await this.db
      .select()
      .from(servicePromptProfiles)
      .where(eq(servicePromptProfiles.id, 'default'))
      .get();
    return this.mapRow(raced!);
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async createServicePromptProfile(input: CreateServicePromptProfileData): Promise<ServicePromptProfile> {
    const id = this.idGen.next('service_prompt_profile');
    const now = this.clock.now();
    const rows = await this.db.select().from(servicePromptProfiles).all();
    const maxOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), -1);
    const [row] = await this.db
      .insert(servicePromptProfiles)
      .values({
        id,
        name: input.name,
        isDefault: 0,
        sortOrder: maxOrder + 1,
        overrides: serializeOverrides(input.overrides ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRow(row!);
  }

  /**
   * Patch-apply update; bumps updatedAt. Returns null when id is unknown.
   *
   * Default-profile guard: the "default" profile's name and overrides are
   * immutable — attempts to rename or write overrides are silently ignored
   * (only updatedAt would bump, but we also skip that for default so the
   * row stays inert). This mirrors the "refuse default" pattern requested in
   * the task and is documented here as the chosen behavior (silent-ignore over
   * throw) to keep callers idempotent.
   */
  async updateServicePromptProfile(
    id: string,
    patch: UpdateServicePromptProfileData,
  ): Promise<ServicePromptProfile | null> {
    const isDefault = id === 'default';
    const values: Partial<typeof servicePromptProfiles.$inferInsert> = {};

    // Default guard: never allow rename or overrides mutation.
    if (!isDefault) {
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.overrides !== undefined) values.overrides = serializeOverrides(patch.overrides);
    } else {
      // If caller only tried to mutate refused fields, treat as no-op.
      if (patch.name === undefined && patch.overrides === undefined) return this.getServicePromptProfile(id);
      // Silently ignore refused fields — don't bump updatedAt.
      const existing = await this.db
        .select()
        .from(servicePromptProfiles)
        .where(eq(servicePromptProfiles.id, id))
        .get();
      return existing ? this.mapRow(existing) : null;
    }

    // If patch was empty after guard, nothing to update.
    if (Object.keys(values).length === 0) {
      const row = await this.db
        .select()
        .from(servicePromptProfiles)
        .where(eq(servicePromptProfiles.id, id))
        .get();
      return row ? this.mapRow(row) : null;
    }

    values.updatedAt = this.clock.now();

    const [row] = await this.db
      .update(servicePromptProfiles)
      .set(values)
      .where(eq(servicePromptProfiles.id, id))
      .returning();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Deletes the profile. Refuses to delete the default profile (id "default")
   * — returns without deleting (silent no-op) so callers remain idempotent.
   * Documented as the chosen "refuse" behavior over throwing.
   */
  async deleteServicePromptProfile(id: string): Promise<void> {
    if (id === 'default') return;
    await this.db.delete(servicePromptProfiles).where(eq(servicePromptProfiles.id, id)).run();
  }

  async reorderServicePromptProfiles(updates: Array<{ id: string; sortOrder: number }>): Promise<ServicePromptProfile[]> {
    for (const u of updates) {
      if (u.id === 'default') continue;
      await this.db
        .update(servicePromptProfiles)
        .set({ sortOrder: u.sortOrder, updatedAt: this.clock.now() })
        .where(eq(servicePromptProfiles.id, u.id))
        .run();
    }
    return this.listServicePromptProfiles();
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof servicePromptProfiles.$inferSelect): ServicePromptProfile {
    return {
      id: brandId<ServicePromptProfileId>(row.id),
      name: row.name,
      isDefault: row.isDefault === 1,
      sortOrder: row.sortOrder ?? 0,
      overrides: parseOverrides(row.overrides),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
