import { createStoreContainer, type StoreContainer } from '@rp-platform/db';
import { resolve } from 'path';

export function createRuntimeStore(dataDir?: string): StoreContainer {
  let dbPath: string;

  if (dataDir) {
    // Standalone mode: explicit data directory from standalone-paths
    dbPath = resolve(dataDir, 'rp-platform.db');
  } else {
    // Dev/prod mode: resolve from source tree root (backward compat)
    const rootDir = process.env.RP_PLATFORM_ROOT_DIR ?? resolve(import.meta.dir, '..', '..', '..');
    dbPath = resolve(rootDir, process.env.RP_PLATFORM_DB_PATH ?? 'data/rp-platform.db');
  }

  return createStoreContainer(dbPath);
}
