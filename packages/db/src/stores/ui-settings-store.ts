import { eq } from 'drizzle-orm';
import { uiSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level UI settings — app preferences projected from a DB row.
 */
export interface UiSettings {
  id: string;
  theme: string;
  chatFontSize: number;
  uiFontSize: number;
  messageWidth: number;
  language: string;
  activePromptPresetId: string | null;
  aiAssistantProviderId: string | null;
  aiAssistantModelName: string | null;
  coauthorProviderId: string | null;
  coauthorModelName: string | null;
  /** Null inherits the bound profile/model's effective max output tokens. */
  coauthorMaxTokens: number | null;
  /** Null inherits the bound profile/model's effective context budget. */
  coauthorContextBudget: number | null;
  /** True once the user starred the repo or opted out — silences both prompts. */
  githubStarred: boolean;
  /** Monotonic count of user messages ever sent. Server-owned. */
  userMessageCount: number;
  /** Value of userMessageCount at which the star modal becomes due. */
  nextStarPromptAt: number;
  /** How many times "Later" was chosen — selects the backoff interval. */
  starPromptDeferrals: number;
  /** Experience-copilot binding (provider + model). Null/dangling → the shell
   *  falls back to the first available provider profile (the pre-fix default). */
  copilotProviderId: string | null;
  copilotModelName: string | null;
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
  aiAssistantProviderId?: string | null;
  aiAssistantModelName?: string | null;
  coauthorProviderId?: string | null;
  coauthorModelName?: string | null;
  coauthorMaxTokens?: number | null;
  coauthorContextBudget?: number | null;
  githubStarred?: boolean;
  userMessageCount?: number;
  nextStarPromptAt?: number;
  starPromptDeferrals?: number;
  copilotProviderId?: string | null;
  copilotModelName?: string | null;
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
  aiAssistantProviderId: null,
  aiAssistantModelName: null,
  coauthorProviderId: null,
  coauthorModelName: null,
  coauthorMaxTokens: null,
  coauthorContextBudget: null,
  githubStarred: false,
  userMessageCount: 0,
  nextStarPromptAt: 10,
  starPromptDeferrals: 0,
  copilotProviderId: null,
  copilotModelName: null,
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
      const values: Partial<typeof uiSettings.$inferInsert> = { ...partial, updatedAt: this.clock.now() };
      const [row] = await this.db.update(uiSettings).set(values).where(eq(uiSettings.id, 'default')).returning();
      return this.mapRow(row!);
    }
    const [row] = await this.db.insert(uiSettings).values({
      id: 'default',
      theme: partial.theme ?? UI_SETTINGS_DEFAULTS.theme,
      chatFontSize: partial.chatFontSize ?? UI_SETTINGS_DEFAULTS.chatFontSize,
      uiFontSize: partial.uiFontSize ?? UI_SETTINGS_DEFAULTS.uiFontSize,
      messageWidth: partial.messageWidth ?? UI_SETTINGS_DEFAULTS.messageWidth,
      language: partial.language ?? UI_SETTINGS_DEFAULTS.language,
      activePromptPresetId: partial.activePromptPresetId ?? UI_SETTINGS_DEFAULTS.activePromptPresetId,
      aiAssistantProviderId: partial.aiAssistantProviderId ?? UI_SETTINGS_DEFAULTS.aiAssistantProviderId,
      aiAssistantModelName: partial.aiAssistantModelName ?? UI_SETTINGS_DEFAULTS.aiAssistantModelName,
      coauthorProviderId: partial.coauthorProviderId ?? UI_SETTINGS_DEFAULTS.coauthorProviderId,
      coauthorModelName: partial.coauthorModelName ?? UI_SETTINGS_DEFAULTS.coauthorModelName,
      coauthorMaxTokens: partial.coauthorMaxTokens ?? UI_SETTINGS_DEFAULTS.coauthorMaxTokens,
      coauthorContextBudget: partial.coauthorContextBudget ?? UI_SETTINGS_DEFAULTS.coauthorContextBudget,
      githubStarred: partial.githubStarred ?? UI_SETTINGS_DEFAULTS.githubStarred,
      userMessageCount: partial.userMessageCount ?? UI_SETTINGS_DEFAULTS.userMessageCount,
      nextStarPromptAt: partial.nextStarPromptAt ?? UI_SETTINGS_DEFAULTS.nextStarPromptAt,
      starPromptDeferrals: partial.starPromptDeferrals ?? UI_SETTINGS_DEFAULTS.starPromptDeferrals,
      copilotProviderId: partial.copilotProviderId ?? UI_SETTINGS_DEFAULTS.copilotProviderId,
      copilotModelName: partial.copilotModelName ?? UI_SETTINGS_DEFAULTS.copilotModelName,
      updatedAt: this.clock.now(),
    }).returning();
    return this.mapRow(row!);
  }

  async ensureDefaults(): Promise<UiSettings> {
    const existing = await this.db.select().from(uiSettings).where(eq(uiSettings.id, 'default')).get();
    if (existing) {
      return this.mapRow(existing);
    }

    const [row] = await this.db.insert(uiSettings).values({
      id: 'default',
      theme: UI_SETTINGS_DEFAULTS.theme,
      chatFontSize: UI_SETTINGS_DEFAULTS.chatFontSize,
      uiFontSize: UI_SETTINGS_DEFAULTS.uiFontSize,
      messageWidth: UI_SETTINGS_DEFAULTS.messageWidth,
      language: UI_SETTINGS_DEFAULTS.language,
      activePromptPresetId: UI_SETTINGS_DEFAULTS.activePromptPresetId,
      aiAssistantProviderId: UI_SETTINGS_DEFAULTS.aiAssistantProviderId,
      aiAssistantModelName: UI_SETTINGS_DEFAULTS.aiAssistantModelName,
      coauthorProviderId: UI_SETTINGS_DEFAULTS.coauthorProviderId,
      coauthorModelName: UI_SETTINGS_DEFAULTS.coauthorModelName,
      coauthorMaxTokens: UI_SETTINGS_DEFAULTS.coauthorMaxTokens,
      coauthorContextBudget: UI_SETTINGS_DEFAULTS.coauthorContextBudget,
      githubStarred: UI_SETTINGS_DEFAULTS.githubStarred,
      userMessageCount: UI_SETTINGS_DEFAULTS.userMessageCount,
      nextStarPromptAt: UI_SETTINGS_DEFAULTS.nextStarPromptAt,
      starPromptDeferrals: UI_SETTINGS_DEFAULTS.starPromptDeferrals,
      copilotProviderId: UI_SETTINGS_DEFAULTS.copilotProviderId,
      copilotModelName: UI_SETTINGS_DEFAULTS.copilotModelName,
      updatedAt: this.clock.now(),
    }).returning();

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
      aiAssistantProviderId: row.aiAssistantProviderId ?? null,
      aiAssistantModelName: row.aiAssistantModelName ?? null,
      coauthorProviderId: row.coauthorProviderId ?? null,
      coauthorModelName: row.coauthorModelName ?? null,
      coauthorMaxTokens: row.coauthorMaxTokens ?? null,
      coauthorContextBudget: row.coauthorContextBudget ?? null,
      githubStarred: row.githubStarred,
      userMessageCount: row.userMessageCount,
      nextStarPromptAt: row.nextStarPromptAt,
      starPromptDeferrals: row.starPromptDeferrals,
      copilotProviderId: row.copilotProviderId ?? null,
      copilotModelName: row.copilotModelName ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
