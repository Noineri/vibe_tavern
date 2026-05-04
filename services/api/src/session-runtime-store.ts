import { createStoreContainer, type StoreContainer } from '@rp-platform/db';
import { resolve } from 'path';

export function createRuntimeStore(): StoreContainer {
  const rootDir = resolve(import.meta.dir, '..', '..', '..');
  const dbPath = resolve(rootDir, process.env.RP_PLATFORM_DB_PATH ?? 'data/rp-platform.db');
  return createStoreContainer(dbPath);
}
