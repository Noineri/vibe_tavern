import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";

/**
 * Data + label seam for the one shared skill library modal (AP-22,
 * AGENT_SHELL_POLISH Wave 5). The view (`skill-library-modal.tsx`) owns ALL
 * markup and view state; a wrapper (the agent copilot's per-kind
 * `AgentSkillModal`, the global-store `CoauthorSkillModal`) reads its own
 * zustand store, binds its own API roots, and hands the modal this adapter.
 * Nothing below is React-aware — `entries`/`isLoading`/`hasLoaded` are plain
 * snapshot values the wrapper re-reads through its store hooks each render.
 */

/**
 * i18n keys for the shared view. The two wrappers use different key
 * namespaces (agent copilot: flat `copilot_skill_*`; Co-Author: nested
 * `coauthor.skill.*`), so the wrapper supplies ITS namespace's keys and the
 * view resolves them through `tDynamic` — the deliberately loose-key sibling
 * of `t`, because these key strings are adapter data, not call-site literals.
 * Key-for-key with the pre-merge modals; the merge adds NO new keys.
 */
export interface SkillLibraryLabels {
	/** Global modal title / subtitle. */
	title: string;
	subtitle: string;
	/** Footer close button. */
	close: string;
	/** Header import button (idle / in-progress labels). */
	import: string;
	importing: string;
	/** Import result toasts. */
	importSuccess: string;
	importFailed: string;
	/** Master list header + loading line. */
	listLabel: string;
	loading: string;
	/** Empty library / empty detail states. */
	empty: string;
	emptySub: string;
	emptyDetail: string;
	/** Delete action label + result toasts. */
	delete: string;
	deleted: string;
	deleteFailed: string;
	/** Delete confirm (plain case — no modules reference the skill). */
	deleteConfirmTitle: string;
	deleteConfirmBody: string;
	/** Source badges + user-shadows-builtin marker. */
	user: string;
	builtIn: string;
	shadow: string;
	shadowTitle: string;
	/** Detail metadata rows. */
	idLabel: string;
	manifestLabel: string;
	sourceLabel: string;
	inspectHint: string;
}

/**
 * Testids the view renders. The pre-merge modals used different prefixes
 * (`copilot-skill-*` vs `skill-*`); the wrappers keep their exact pre-merge
 * testids so their suites pass unchanged against the merged view.
 */
export interface SkillLibraryTestids {
	/** Hidden folder-upload input. */
	folderInput: string;
	/** Header import button. */
	importBtn: string;
	/** Per-row delete button (view appends the skill id). */
	deleteBtn: (skillId: string) => string;
	/** Detail-pane delete button. */
	detailDeleteBtn: string;
	/** Per-row wrapper testid (view appends the skill id). Omit for no row
	 *  testid — the Co-Author wrapper's rows never carried one. */
	row?: (skillId: string) => string;
}

/**
 * Optional delete reference guard (the Co-Author «used by these modules»
 * flow): before a delete confirm opens, resolve which modules still bind the
 * skill so the confirm can NAME them instead of silently leaving broken
 * bindings. The guard is data-driven (modules referencing a skill), so it
 * lives in the adapter; its i18n keys stay in the wrapper's namespace.
 */
export interface SkillLibraryReferenceGuard {
	/** Module names that still bind the skill (empty → plain confirm). */
	findReferencingModules: (skillId: string) => Promise<string[]>;
	/** Confirm-body i18n keys for the referenced case (body + hint lines). */
	referencedBody: string;
	referencedHint: string;
}

export interface SkillLibraryAdapter {
	labels: SkillLibraryLabels;
	testids: SkillLibraryTestids;
	/** The merged metadata-only catalog snapshot (built-in + user skills,
	 *  user shadows builtin). */
	entries: SkillCatalogEntryDto[];
	isLoading: boolean;
	/** True once the first `load` resolved (distinguishes "loading" from
	 *  "loaded an empty list"). */
	hasLoaded: boolean;
	/** Fetch the catalog. Safe to call repeatedly. STABILITY CONTRACT: the
	 *  identity must not change across renders while the same library is
	 *  open — the modal's open effect keys on it (the pre-merge modals keyed
	 *  on their stable store action + kind prop), so a fresh arrow per
	 *  wrapper render would re-fetch on every re-render. */
	load: () => Promise<void>;
	/** Atomically import a skill tree (each file's `webkitRelativePath` is
	 *  its relative path). Returns the imported skill ids. Refreshes the
	 *  catalog. */
	importTree: (files: File[]) => Promise<string[]>;
	/** Delete one user skill by id. A pure built-in is rejected by the
	 *  server. Refreshes the catalog. */
	remove: (skillId: string) => Promise<void>;
	/** Optional delete reference guard — absent means every delete goes
	 *  straight to a plain confirm (the agent copilot libraries have no
	 *  module bindings to consult). */
	referenceGuard?: SkillLibraryReferenceGuard;
}
