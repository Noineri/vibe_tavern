import { createStoreContainer, type StoreContainer } from '@rp-platform/db';
import { resolve } from 'path';

export function createRuntimeStore(): StoreContainer {
  const dbPath = resolve(process.cwd(), 'data/rp-platform.db');
  return createStoreContainer(dbPath);
}
