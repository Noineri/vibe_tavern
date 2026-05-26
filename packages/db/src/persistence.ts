import { createDb, type AppDb } from './db-connection.js';
import { ContentStore } from './content-store.js';
import { createFileStore } from './file-store.js';
import { CharacterStore, PersonaStore, ProviderStore, ChatStore, PresetStore, UiSettingsStore, LorebookStore, ScriptStore } from './stores/index.js';

export interface StoreContainer {
  db: AppDb;
  content: ContentStore;
  characters: CharacterStore;
  personas: PersonaStore;
  providers: ProviderStore;
  chats: ChatStore;
  presets: PresetStore;
  uiSettings: UiSettingsStore;
  lorebooks: LorebookStore;
  scripts: ScriptStore;
}

export async function createStoreContainer(dbPath: string, dataDir?: string): Promise<StoreContainer> {
  const db = await createDb(dbPath);
  const fileStore = createFileStore(dataDir);
  const content = new ContentStore({ fileStore });
  return {
    db,
    content,
    characters: new CharacterStore(db),
    personas: new PersonaStore(db, { content }),
    providers: new ProviderStore(db),
    chats: new ChatStore(db),
    presets: new PresetStore(db),
    uiSettings: new UiSettingsStore(db),
    lorebooks: new LorebookStore(db),
    scripts: new ScriptStore(db),
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
