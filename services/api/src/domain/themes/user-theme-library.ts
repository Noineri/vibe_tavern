import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "@vibe-tavern/db";
import { MAX_USER_THEME_BYTES, uploadUserThemeSchema, userThemeSlugSchema, type UploadUserTheme, type UserTheme, type UserThemeSummary } from "@vibe-tavern/api-contracts";
import { notFound, validation } from "../../shared/errors.js";
import { normalizeUserThemeCss } from "./user-theme-css.js";

const NAME_HEADER = /^\/\* VT theme name: ([^\r\n]*?) \*\/\r?\n/;

/** File-backed library like the skill library: no DB row, portable data-root files. */
export class UserThemeLibrary {
  private readonly root: string;
  constructor(private readonly files: Pick<FileStore, "dataRoot" | "writeText" | "deleteFile">) {
    this.root = join(files.dataRoot, "themes");
  }

  private path(id: string): string {
    if (!userThemeSlugSchema.safeParse(id).success) throw validation("Invalid user theme id.", { code: "invalid-id" });
    return join(this.root, `${id}.css`);
  }

  async list(): Promise<UserThemeSummary[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const result: UserThemeSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
      const id = entry.name.slice(0, -4);
      if (!userThemeSlugSchema.safeParse(id).success) continue;
      try {
        const theme = await this.read(id);
        result.push({ id: theme.id, name: theme.name });
      } catch (error) {
        // A concurrent delete is a normal catalog race, not a failed listing.
        if (error instanceof Error && "kind" in error && error.kind === "NotFound") continue;
        throw error;
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<UserTheme> {
    const path = this.path(id);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) throw notFound("user theme");
      if (stat.size > MAX_USER_THEME_BYTES + 2048) throw validation("Theme exceeds the 1 MiB limit.", { code: "too-large" });
      const stored = await Bun.file(path).text();
      const header = NAME_HEADER.exec(stored);
      let name = `${id}.css`;
      if (header) {
        try { name = decodeURIComponent(header[1]); }
        catch { /* A manually edited metadata comment falls back to its filename. */ }
      }
      return { id, name, css: header ? stored.slice(header[0].length) : stored };
    } catch (error) {
      if (isMissing(error)) throw notFound("user theme");
      throw error;
    }
  }

  async upload(input: UploadUserTheme): Promise<UserTheme> {
    const parsed = uploadUserThemeSchema.safeParse(input);
    if (!parsed.success) throw validation("Expected a .css filename and CSS up to 1 MiB.", { code: "invalid-upload" });
    const { name, css } = parsed.data;
    if (Buffer.byteLength(css, "utf8") > MAX_USER_THEME_BYTES) throw validation("Theme exceeds the 1 MiB limit.", { code: "too-large" });
    const base = name.slice(0, -4).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 47).replace(/-$/, "") || "theme";
    const id = `${base}-${crypto.randomUUID().replace(/-/g, "")}`;
    const normalized = normalizeUserThemeCss(css, id);
    if (Buffer.byteLength(normalized, "utf8") > MAX_USER_THEME_BYTES) throw validation("Normalized theme exceeds the 1 MiB limit.", { code: "too-large" });
    const theme = { id, name, css: normalized };
    await mkdir(this.root, { recursive: true });
    await this.files.writeText(this.path(id), `/* VT theme name: ${encodeURIComponent(name)} */\n${normalized}`);
    return theme;
  }

  async delete(id: string): Promise<void> {
    await this.read(id); // Same path/type gate as reads; never follow a symlink.
    await this.files.deleteFile(this.path(id));
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
