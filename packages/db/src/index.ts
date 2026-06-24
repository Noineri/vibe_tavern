export * from './db-schema.js';
export { createDb, resolveMigrationsFolder, type AppDb } from './db-connection.js';
export {
  createStoreContainer,
  IncrementingStoreIdGenerator,
  resolveStoreRuntime,
  SystemStoreClock,
  type StoreClock,
  type StoreContainer,
  type StoreIdGenerator,
  type StoreRuntimeOptions,
} from './persistence.js';
export { createFileStore, STORAGE_FOLDERS, IMAGE_EXTENSIONS, type FileStore, type StorageFolder } from './file-store.js';
export { ContentStore } from './content-store.js';

// VTF codecs — exposed for the Vibe MD editor sync core (apps/web) and other
// consumers that need to parse/serialize the canonical profile.md document
// (structural pinning, body ↔ prose-field bridging). The folder facade below
// remains server-side (store-facing); only the leaf codecs are re-exported.
export {
  parseProfileMd,
  serializeProfileMd,
  DEFAULT_MES_EXAMPLE_MODE,
  DEFAULT_DEPTH,
  type VtfProfile,
  type ProfileMd,
  type ParsedProfile,
  type FrontmatterEntry,
  type BodySection,
} from './vtf/profile-md.js';
export {
  readInstructions,
  writeInstructions,
  EMPTY_INSTRUCTIONS,
  type VtfInstructions,
} from './vtf/instructions.js';
export {
  packMonolith,
  unpackMonolith,
  serializeCharacterFolder,
  parseCharacterFolder,
  type VtfCharacterContent,
  type FolderFileEntry,
} from './vtf/index.js';
export * from './stores/index.js';
