import { createDb, type AppDb } from './db-connection.js';
import { ContentStore } from './content-store.js';
import { createFileStore } from './file-store.js';
import { CharacterStore, CharacterFolder, CharacterDirectoryRegistry, PersonaStore, ProviderStore, ChatStore, ChatSummaryStore, PresetStore, UiSettingsStore, LorebookStore, ScriptStore, CharacterAssetStore, MessageStore, PromptTraceStore, VersionStore, CoauthorModuleStore } from './stores/index.js';

export interface StoreContainer {
  db: AppDb;
  content: ContentStore;
  characterDirectory: CharacterDirectoryRegistry;
  characters: CharacterStore;
  versions: VersionStore;
  personas: PersonaStore;
  providers: ProviderStore;
  chats: ChatStore;
  messages: MessageStore;
  traces: PromptTraceStore;
  chatSummaries: ChatSummaryStore;
  presets: PresetStore;
  uiSettings: UiSettingsStore;
  lorebooks: LorebookStore;
  scripts: ScriptStore;
  characterAssets: CharacterAssetStore;
  coauthorModules: CoauthorModuleStore;
}

export async function createStoreContainer(dbPath: string, dataDir?: string): Promise<StoreContainer> {
  const db = await createDb(dbPath);
  const fileStore = createFileStore(dataDir);
  const content = new ContentStore({ fileStore });
  const characterFolder = new CharacterFolder(content);
  // The registry scans data/characters/ once at startup, reading each
  // profile.md's vt.storage_id to build characterId → directory. It is the
  // sole directory locator: CharacterStore and VersionStore resolve every
  // character-folder I/O through it (HRF-3d), so the DB folder_name column is
  // no longer consulted at runtime (retired in HRF-6).
  const characterDirectory = new CharacterDirectoryRegistry(content);
  await characterDirectory.init();
  // HRF-4: repair directories left at a stale name by an interrupted/failed
  // rename (opaque-id dirs are skipped — HRF-5 migrates them). A consistent
  // tree is a no-op; individual failures never hide data and are retried next
  // startup, but must be visible to the operator.
  const directoryRepairs = await characterDirectory.reconcile();
  for (const repair of directoryRepairs) {
    if (repair.failed) {
      console.warn(
        `[character-directory] reconciliation failed for ${repair.characterId}: ` +
        `${repair.from} → ${repair.to}: ${repair.error ?? 'unknown filesystem error'}`,
      );
    }
  }
  const chats = new ChatStore(db);
  await chats.migrateGreetingVariants();
  const characters = new CharacterStore(db, { folder: characterFolder, registry: characterDirectory });

  return {
    db,
    content,
    characterDirectory,
    characters,
    versions: new VersionStore(db, { folder: characterFolder, registry: characterDirectory }),
    personas: new PersonaStore(db, { content }),
    providers: new ProviderStore(db),
    chats,
    messages: new MessageStore(db),
    traces: new PromptTraceStore(db),
    chatSummaries: new ChatSummaryStore(db, { content }),
    presets: new PresetStore(db, { content }),
    uiSettings: new UiSettingsStore(db),
    lorebooks: new LorebookStore(db, { content }),
    scripts: new ScriptStore(db, { content }),
    characterAssets: new CharacterAssetStore(db),
    coauthorModules: new CoauthorModuleStore(db),
  };
}

export interface StoreClock {
  now(): string;
}

export interface StoreIdGenerator {
  next(prefix: string): string;
}

export interface StoreRuntimeOptions {
  clock?: StoreClock;
  idGenerator?: StoreIdGenerator;
}

export class SystemStoreClock implements StoreClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class IncrementingStoreIdGenerator implements StoreIdGenerator {
  private readonly counters = new Map<string, number>();
  private readonly sessionSeed = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  next(prefix: string): string {
    const nextValue = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, nextValue);
    return `${prefix}_${this.sessionSeed}_${String(nextValue).padStart(4, "0")}`;
  }
}

export function resolveStoreRuntime(
  options: StoreRuntimeOptions = {},
): Required<StoreRuntimeOptions> {
  return {
    clock: options.clock ?? new SystemStoreClock(),
    idGenerator: options.idGenerator ?? new IncrementingStoreIdGenerator(),
  };
}
