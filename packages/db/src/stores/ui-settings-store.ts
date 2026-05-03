import { eq } from 'drizzle-orm';
import { uiSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return type ──────────────────────────────────────────────────────────────

export interface UiSettings {
  id: string;
  theme: string;
  chatFontSize: number;
  uiFontSize: number;
  messageWidth: number;
  language: string;
  activePromptPresetId: string | null;
  updatedAt: string;
}

// ─── Input type ───────────────────────────────────────────────────────────────

export interface UiSettingsUpdate {
  theme?: string;
  chatFontSize?: number;
  uiFontSize?: number;
  messageWidth?: number;
  language?: string;
  activePromptPresetId?: string | null;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const UI_SETTINGS_DEFAULTS: Omit<UiSettings, 'updatedAt'> = {
  id: 'default',
  theme: 'dark',
  chatFontSize: 15,
  uiFontSize: 14,
  messageWidth: 700,
  language: 'en',
  activePromptPresetId: null,
};

// ─── Store ────────────────────────────────────────────────────────────────────

export class UiSettingsStore {
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

  async get(): Promise<UiSettings> {
    const row = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    if (!row) {
      return { ...UI_SETTINGS_DEFAULTS, updatedAt: '' };
    }
    return this.mapRow(row);
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async update(partial: UiSettingsUpdate): Promise<UiSettings> {
    const existing = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    if (existing) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values: Record<string, any> = { ...partial, updatedAt: this.clock.now() };
      await this.db.update(uiSettings).set(values).where(eq(uiSettings.id, 'default')).run();
    } else {
      await this.db.insert(uiSettings).values({
        id: 'default',
        theme: partial.theme ?? UI_SETTINGS_DEFAULTS.theme,
        chatFontSize: partial.chatFontSize ?? UI_SETTINGS_DEFAULTS.chatFontSize,
        uiFontSize: partial.uiFontSize ?? UI_SETTINGS_DEFAULTS.uiFontSize,
        messageWidth: partial.messageWidth ?? UI_SETTINGS_DEFAULTS.messageWidth,
        language: partial.language ?? UI_SETTINGS_DEFAULTS.language,
        activePromptPresetId: partial.activePromptPresetId ?? UI_SETTINGS_DEFAULTS.activePromptPresetId,
        updatedAt: this.clock.now(),
      }).run();
    }
    const result = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    return this.mapRow(result!);
  }

  async ensureDefaults(): Promise<UiSettings> {
    const existing = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    if (existing) {
      return this.mapRow(existing);
    }

    const now = this.clock.now();
    await this.db.insert(uiSettings).values({
      id: 'default',
      theme: UI_SETTINGS_DEFAULTS.theme,
      chatFontSize: UI_SETTINGS_DEFAULTS.chatFontSize,
      uiFontSize: UI_SETTINGS_DEFAULTS.uiFontSize,
      messageWidth: UI_SETTINGS_DEFAULTS.messageWidth,
      language: UI_SETTINGS_DEFAULTS.language,
      activePromptPresetId: UI_SETTINGS_DEFAULTS.activePromptPresetId,
      updatedAt: now,
    }).run();

    const row = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    return this.mapRow(row!);
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof uiSettings.$inferSelect): UiSettings {
    return {
      id: row.id,
      theme: row.theme,
      chatFontSize: row.chatFontSize,
      uiFontSize: row.uiFontSize,
      messageWidth: row.messageWidth,
      language: row.language,
      activePromptPresetId: row.activePromptPresetId,
      updatedAt: row.updatedAt,
    };
  }
}
