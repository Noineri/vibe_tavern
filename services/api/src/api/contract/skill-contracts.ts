// Co-Author + copilot skill contracts (extracted from runtime-api.ts when the
// AS-8d1 per-kind seam grew that file past its line baseline — the same
// sibling-module pattern as copilot-profile-contracts.ts / lorebook-script-
// contracts.ts; runtime-api.ts re-exports everything so existing import paths
// keep resolving).

import type { SkillCatalogEntryDto, SkillContentDto } from "@vibe-tavern/api-contracts";
import type { SkillImportFile, SkillImportResult, SkillSaveInput } from "../../domain/coauthor/skills/skill-library.js";

/** The Co-Author skill library's order key (ML-7): the copilot skill libraries
 *  are keyed by their agent-kind id — the SAME string the per-kind routes
 *  resolve through the kind registry ('experience', 'script', 'sidechat-ooc')
 *  — and the Co-Author library has no kind id, so its key is this constant.
 *  One key per library, derived from the existing route families (never a
 *  second hand-written list). */
export const COAUTHOR_SKILL_LIBRARY = "coauthor";

// ─── Co-Author Skills (filesystem skill libraries) ──────────────────
// CTX-S2: import (multipart files → validated atomic tree under
// <dataDir>/coauthor/skills) + delete one user skill directory.
// CTX-S3: metadata-only catalog (list/read) merging built-in + user roots with
// user precedence. Absolute filesystem paths never leave the server — only the
// portable root-relative manifest path (`<id>/SKILL.md`) is exposed.

export interface CoauthorSkillsRuntimeApi {
	/** Validate + atomically import a skill tree (ordinary files with relative
	 *  paths). Rejects unsafe paths, malformed manifests, and trees with no
	 *  SKILL.md WITHOUT writing anything. Returns the imported skill ids. */
	importSkills: (files: SkillImportFile[]) => Promise<SkillImportResult>;
	/** Delete one top-level user skill directory. A user shadow of a built-in is
	 *  deletable (removes only the user copy); a pure built-in (no user dir) is
	 *  rejected as read-only; unsafe ids and missing ids are rejected. */
	deleteSkill: (id: string) => Promise<{ id: string }>;
	/** Merged metadata-only catalog (built-in + user, user precedence). Malformed
	 *  manifests are surfaced in `errors`, never fatal. */
	listSkills: () => Promise<{ entries: SkillCatalogEntryDto[]; errors: { source: "builtin" | "user"; id: string; reason: string }[] }>;
	/** One catalog entry by id, or `null` if no such skill exists in either root. */
	readSkill: (id: string) => Promise<SkillCatalogEntryDto | null>;
	/** Full content view of one skill (AP-21): raw manifest (`content`),
	 *  frontmatter-stripped text (`body`), and the folder's relative file paths
	 *  (`files`, manifest excluded) — read through the sandboxed `readSkillFile`
	 *  (user shadow first). `null` when the skill does not exist (404). */
	readSkillContent: (id: string) => Promise<SkillContentDto | null>;
	/** Save one user skill (AP-23a) — the ONE operation behind `POST .../skills`
	 *  (create: `id` absent, folder id derived from the name and de-duplicated
	 *  against both roots) and `PUT .../skills/:id` (update: rewrite ONLY the
	 *  user copy's SKILL.md, frontmatter rebuilt with every existing key kept).
	 *  An invalid manifest is rejected before any write (400); a built-in id on
	 *  update is a 409 conflict (built-ins are read-only). Returns the FRESH
	 *  catalog entry DTO of the saved skill. */
	saveSkill: (input: SkillSaveInput) => Promise<SkillCatalogEntryDto>;
	/** Rewrite THIS library's stored catalog order (ML-7) and return the
	 *  refreshed merged catalog — the same envelope `listSkills` serves
	 *  (known ids in stored positions, ids the order table does not know last,
	 *  alphabetically). The order lives in the `skill_orders` table keyed by
	 *  (library, skill id); an update id the catalog does not list still gets a
	 *  row (inert until that id exists). */
	reorderSkills: (updates: Array<{ id: string; sortOrder: number }>) => Promise<{ entries: SkillCatalogEntryDto[]; errors: { source: "builtin" | "user"; id: string; reason: string }[] }>;
}

/** Copilot skills keyed by agent kind (AS-8d1): the copilot-skill routes
 * resolve `?kind=` through this ONE seam — each kind with a skill library
 * answers with its own adapter (same wire contract, kind-owned roots:
 * `experience-copilot/skills` vs `agent-script/skills` under the data dir).
 * An unknown kind raises the registry's `UNKNOWN_AGENT_KIND` as a validation
 * error (400 through the app error handler — the same seam the copilot-profile
 * adapter's kind check uses); never a silent fallback to another kind. */
export interface CopilotSkillsByKindRuntimeApi {
	copilotSkillsForKind: (kind: string) => CoauthorSkillsRuntimeApi;
}
