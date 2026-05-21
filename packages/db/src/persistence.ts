import { createDb, type AppDb } from './db-connection.js';
import { CharacterStore, PersonaStore, ProviderStore, ChatStore, PresetStore, UiSettingsStore, LorebookStore } from './stores/index.js';

export interface StoreContainer {
  db: AppDb;
  characters: CharacterStore;
  personas: PersonaStore;
  providers: ProviderStore;
  chats: ChatStore;
  presets: PresetStore;
  uiSettings: UiSettingsStore;
  lorebooks: LorebookStore;
}

export async function createStoreContainer(dbPath: string): Promise<StoreContainer> {
  const db = await createDb(dbPath);
  return {
    db,
    characters: new CharacterStore(db),
    personas: new PersonaStore(db),
    providers: new ProviderStore(db),
    chats: new ChatStore(db),
    presets: new PresetStore(db),
    uiSettings: new UiSettingsStore(db),
    lorebooks: new LorebookStore(db),
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
