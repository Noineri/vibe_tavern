import { createStoreContainer, type StoreContainer } from '@vibe-tavern/db';
import { resolve } from 'node:path';

export async function createRuntimeStore(dataDir?: string): Promise<StoreContainer> {
  let dbPath: string;

  if (dataDir) {
    // Standalone mode: explicit data directory from standalone-paths
    dbPath = resolve(dataDir, 'vibe-tavern.db');
  } else {
    // Dev/prod mode: resolve from source tree root (backward compat)
    const rootDir = process.env.RP_PLATFORM_ROOT_DIR ?? resolve(import.meta.dir, '..', '..', '..');
    dbPath = resolve(rootDir, process.env.VIBE_TAVERN_DB_PATH ?? 'data/vibe-tavern.db');
  }

  return await createStoreContainer(dbPath, dataDir);
}
