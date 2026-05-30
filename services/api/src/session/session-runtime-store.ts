import { createStoreContainer, type StoreContainer } from '@vibe-tavern/db';
import { resolve } from 'node:path';

function resolveRootDir(): string {
  return resolve(process.env.RP_PLATFORM_ROOT_DIR ?? process.cwd());
}

function resolveDataDir(rootDir: string, dataDir?: string): string {
  if (dataDir) return resolve(dataDir);
  if (process.env.RP_PLATFORM_DATA_DIR) return resolve(process.env.RP_PLATFORM_DATA_DIR);
  return resolve(rootDir, 'data');
}

function resolveDbPath(rootDir: string, resolvedDataDir: string): string {
  // RP_PLATFORM_DB_PATH is the public env var used by Docker/tests. Keep
  // VIBE_TAVERN_DB_PATH as a backward-compatible alias for older local setups.
  const configuredDbPath = process.env.RP_PLATFORM_DB_PATH ?? process.env.VIBE_TAVERN_DB_PATH;
  if (configuredDbPath) return resolve(rootDir, configuredDbPath);
  return resolve(resolvedDataDir, 'vibe-tavern.db');
}

export interface RuntimeStorePaths {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
}

export function resolveRuntimeStorePaths(dataDir?: string): RuntimeStorePaths {
  const rootDir = resolveRootDir();
  const resolvedDataDir = resolveDataDir(rootDir, dataDir);
  return {
    rootDir,
    dataDir: resolvedDataDir,
    dbPath: resolveDbPath(rootDir, resolvedDataDir),
  };
}

export async function createRuntimeStore(dataDir?: string): Promise<StoreContainer> {
  const paths = resolveRuntimeStorePaths(dataDir);

  console.log(`[db] Database: ${paths.dbPath}`);
  return await createStoreContainer(paths.dbPath, paths.dataDir);
}
