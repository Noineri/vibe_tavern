import { dirname } from "node:path";
import type { ContentStore } from "@vibe-tavern/db";
import { STORAGE_FOLDERS } from "@vibe-tavern/db";

/**
 * TPE-18c: per-character narration library — one OGG Vorbis file per
 * narrated message, stored server-side under the character's EXISTING
 * assets folder:
 *
 *   data/characters/{characterId}/narrations/{chatId}/{branchId}/{messageId}/{variantIndex}.ogg
 *
 * The PATH encodes all the metadata (owner decision: no manifest sidecar,
 * no extra DB table — blobs+manifest were vetoed). Subfolder precedent:
 * greetings/, gallery/{rowId}.{ext} (asset-service.ts).
 *
 * Validation is two gates: every ID segment must match the slug pattern
 * below (rejects traversal/absolute/.. BEFORE any filesystem touch), and
 * FileStore.safeResolve re-enforces containment as the second gate.
 */

export interface NarrationLibraryKey {
  characterId: string;
  chatId: string;
  branchId: string;
  messageId: string;
  variantIndex: number;
}

/** Owner IDs are `prefix_seed_counter` slugs (persistence.ts) — this also
 *  admits uuid-style character ids (dashes). Anything else (slashes,
 *  dots, drive letters, empty) is rejected before path construction. */
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_VARIANT_INDEX = 999;

/** Served/stored MIME for every library file (owner format decision). */
export const NARRATION_LIBRARY_MIME = "audio/ogg";

export class NarrationLibraryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrationLibraryValidationError";
  }
}

/** The host platform has no file manager to reveal (or spawn is
 *  unavailable) — the route maps this to 501, the client hides the
 *  button where no file manager exists (Android). */
export class NarrationRevealUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrationRevealUnsupportedError";
  }
}

function checkIdSegment(name: string, value: unknown): string {
  if (typeof value !== "string" || !ID_SEGMENT_PATTERN.test(value)) {
    throw new NarrationLibraryValidationError(`invalid narration library ${name}`);
  }
  return value;
}

/** Validate a wire key (JSON body, query params, multipart fields —
 *  variantIndex may arrive as a numeric string). Pure, unit-tested. */
export function parseNarrationLibraryKey(input: unknown): NarrationLibraryKey {
  if (typeof input !== "object" || input === null) {
    throw new NarrationLibraryValidationError("invalid narration library key");
  }
  const record = input as Record<string, unknown>;
  const rawVariant = record["variantIndex"];
  const variantIndex =
    typeof rawVariant === "number"
      ? rawVariant
      : typeof rawVariant === "string" && rawVariant.trim() !== ""
        ? Number(rawVariant)
        : NaN;
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex > MAX_VARIANT_INDEX) {
    throw new NarrationLibraryValidationError("invalid narration library variantIndex");
  }
  return {
    characterId: checkIdSegment("characterId", record["characterId"]),
    chatId: checkIdSegment("chatId", record["chatId"]),
    branchId: checkIdSegment("branchId", record["branchId"]),
    messageId: checkIdSegment("messageId", record["messageId"]),
    variantIndex,
  };
}

/** Leaf inside the character folder (multi-segment — ContentStore binary
 *  helpers accept those, same as gallery/{rowId}.{ext}). */
export function narrationLibraryLeaf(key: NarrationLibraryKey): string {
  return `narrations/${key.chatId}/${key.branchId}/${key.messageId}/${key.variantIndex}.ogg`;
}

/** argv to reveal one file in the OS file manager — pure per platform,
 *  unit-tested (the right command AND traversal rejection live here). */
export function revealCommandForPlatform(platform: string, absolutePath: string): string[] {
  if (platform === "win32") return ["explorer.exe", `/select,${absolutePath}`];
  if (platform === "darwin") return ["open", "-R", absolutePath];
  if (platform === "linux" || platform === "freebsd") return ["xdg-open", dirname(absolutePath)];
  throw new NarrationRevealUnsupportedError(`file reveal is not supported on ${platform}`);
}

/** Spawn-a-process seam (docker-probe pattern): tests inject a recorder,
 *  prod spawns detached and never awaits the manager. */
export type NarrationRevealSpawn = (argv: string[]) => void | Promise<void>;

function defaultSpawn(argv: string[]): void {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  child.unref();
}

export interface NarrationLibraryDeps {
  content: ContentStore;
  /** characterId → on-disk folder name (HUMAN_READABLE_FOLDERS — the same
   *  resolver AssetService uses, so narrations land next to avatars). */
  resolveCharacterFolder: (characterId: string) => Promise<string>;
  spawn?: NarrationRevealSpawn;
  /** Override for tests (defaults to the host platform). */
  platform?: string;
}

export class NarrationLibraryService {
  private readonly content: ContentStore;
  private readonly resolveCharacterFolder: (characterId: string) => Promise<string>;
  private readonly spawn: NarrationRevealSpawn;
  private readonly platform: string;

  constructor(deps: NarrationLibraryDeps) {
    this.content = deps.content;
    this.resolveCharacterFolder = deps.resolveCharacterFolder;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.platform = deps.platform ?? process.platform;
  }

  private async folderFor(characterId: string): Promise<string> {
    return this.resolveCharacterFolder(characterId);
  }

  async save(key: NarrationLibraryKey, audio: Uint8Array): Promise<{ leaf: string }> {
    const folder = await this.folderFor(key.characterId);
    const leaf = narrationLibraryLeaf(key);
    await this.content.writeBinary(STORAGE_FOLDERS.characters, folder, leaf, audio);
    return { leaf };
  }

  async read(key: NarrationLibraryKey): Promise<Buffer | null> {
    const folder = await this.folderFor(key.characterId);
    return this.content.readBinary(STORAGE_FOLDERS.characters, folder, narrationLibraryLeaf(key));
  }

  async exists(key: NarrationLibraryKey): Promise<boolean> {
    const folder = await this.folderFor(key.characterId);
    return this.content.entityLeafExists(STORAGE_FOLDERS.characters, folder, narrationLibraryLeaf(key));
  }

  /** Delete the file; returns whether one existed (deleteBinary itself is
   *  a missing-tolerant no-op, same as AssetService.cleanup). */
  async remove(key: NarrationLibraryKey): Promise<{ deleted: boolean }> {
    const folder = await this.folderFor(key.characterId);
    const leaf = narrationLibraryLeaf(key);
    const existed = await this.content.entityLeafExists(STORAGE_FOLDERS.characters, folder, leaf);
    if (existed) await this.content.deleteBinary(STORAGE_FOLDERS.characters, folder, leaf);
    return { deleted: existed };
  }

  /** Spawn the OS file manager with the saved file selected. The caller
   *  checks exists() first (missing → 404); validation errors → 400,
   *  unsupported platform → 501. Returns the spawned argv for logs. */
  async reveal(key: NarrationLibraryKey): Promise<{ argv: string[] }> {
    const folder = await this.folderFor(key.characterId);
    const absolutePath = this.content.entityLeafPath(
      STORAGE_FOLDERS.characters,
      folder,
      narrationLibraryLeaf(key),
    );
    const argv = revealCommandForPlatform(this.platform, absolutePath);
    await this.spawn(argv);
    return { argv };
  }
}
