// Co-Author + copilot skill contracts (extracted from runtime-api.ts when the
// AS-8d1 per-kind seam grew that file past its line baseline — the same
// sibling-module pattern as copilot-profile-contracts.ts / lorebook-script-
// contracts.ts; runtime-api.ts re-exports everything so existing import paths
// keep resolving).

import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";
import type { SkillImportFile, SkillImportResult } from "../../domain/coauthor/skills/skill-library.js";

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
