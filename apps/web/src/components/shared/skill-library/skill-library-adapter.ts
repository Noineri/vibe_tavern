import type { SkillCatalogEntryDto, SkillContentDto, SkillSaveDto } from "@vibe-tavern/api-contracts";

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
 * AP-22 merged key-for-key with the pre-merge modals; AP-23 adds the polish
 * keys (body preview, toggles, tech details, empty copy, import CTA) and
 * drops the keys whose UI is gone (`close` — the `MasterDetailFooter`
 * primitive owns Close; `empty`/`empty_sub` — superseded by the mockup
 * empty copy; `inspect_hint` — the detail hint line is gone).
 */
export interface SkillLibraryLabels {
	/** Global modal title / subtitle. */
	title: string;
	subtitle: string;
	/** List-bottom + empty-state import buttons (idle / in-progress labels). */
	importCta: string;
	importing: string;
	/** Import result toasts. */
	importSuccess: string;
	importFailed: string;
	/** Master list header + loading line. */
	listLabel: string;
	loading: string;
	/** Empty library (mockup §7 explanation + CTA) / empty detail states. */
	emptyTitle: string;
	emptyBody: string;
	emptyDetail: string;
	/** Delete action label + result toasts. */
	delete: string;
	deleted: string;
	deleteFailed: string;
	/** Delete confirm (plain case — no modules reference the skill). */
	deleteConfirmTitle: string;
	deleteConfirmBody: string;
	/** Source tag («свой» / «встроенный») + user-shadows-builtin marker. */
	user: string;
	builtIn: string;
	shadow: string;
	shadowTitle: string;
	/** Detail metadata rows. */
	idLabel: string;
	manifestLabel: string;
	sourceLabel: string;
	/** Skill body preview (the AP-21 frontmatter-stripped `body`). */
	bodyLabel: string;
	showFull: string;
	collapse: string;
	contentLoading: string;
	/** «Технические детали» disclosure (trigger + hint + files row). */
	techDetails: string;
	techDetailsHint: string;
	filesLabel: string;
	/** Editor (AP-23d, mockup §8): the docked new-skill entry point,
	 *  the footer edit/duplicate verbs, and the editor field labels. */
	newSkill: string;
	edit: string;
	duplicate: string;
	cancel: string;
	save: string;
	/** Save result toasts. */
	saved: string;
	saveFailed: string;
	/** Editor fields: the name field, the when-to-use field + its verbatim
	 *  hint, and the duplicate prefill ("{name} (copy)", interpolated). */
	nameLabel: string;
	whenLabel: string;
	whenHint: string;
	copyName: string;
}

/**
 * Testids the view renders. The pre-merge modals used different prefixes
 * (`copilot-skill-*` vs `skill-*`); the wrappers keep their exact pre-merge
 * prefixes. AP-23 drops the per-row + detail delete testids (delete lives in
 * the shared footer now — suites find it by its label text) and adds the
 * preview/disclosure hooks.
 */
export interface SkillLibraryTestids {
	/** Hidden folder-upload input. */
	folderInput: string;
	/** Import button (list-bottom dock, or the empty-state CTA — only one
	 *  renders at a time). */
	importBtn: string;
	/** Per-row wrapper testid (view appends the skill id). Omit for no row
	 *  testid — the Co-Author wrapper's rows never carried one. */
	row?: (skillId: string) => string;
	/** Skill body clamp toggle + tech-details disclosure trigger. */
	previewToggle: string;
	techDetailsToggle: string;
	/** The rendered body preview block. */
	contentBody: string;
	/** Editor (AP-23d): the docked new-skill button + the three editor
	 *  fields (name / when / body) + the compact AI-assist button. */
	newSkillBtn: string;
	editorName: string;
	editorWhen: string;
	editorBody: string;
	aiAssistBtn: string;
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
	/** Lazy full content view for one skill (AP-21 `.../skills/:id/content`:
	 *  `{ id, path, content, body, files }`), or `null` when absent. The
	 *  modal calls it when the detail opens — ONE shape, each wrapper binds
	 *  its own namespaced client fn. STABILITY CONTRACT: same as `load` —
	 *  the identity must not change across renders (the detail effect keys
	 *  on it). */
	readContent: (id: string) => Promise<SkillContentDto | null>;
	/**
	 * Save one user skill (AP-23d) — the ONE adapter seam behind the editor's
	 * Save button: a `null` id creates (POST — the folder id derives from the
	 * name server-side, so duplicates save as NEW), a set id updates (PUT —
	 * rewrites only that skill's SKILL.md). Each wrapper binds its own
	 * kind-scoped store actions; both refresh the catalog before resolving.
	 */
	save: (id: string | null, input: SkillSaveDto) => Promise<SkillCatalogEntryDto>;
	// ML-9 drag persist seam: FULL new order, the store adopts the refreshed catalog.
	reorder: (updates: Array<{ id: string; sortOrder: number }>) => Promise<void>;
	/** Optional delete reference guard — absent means every delete goes
	 *  straight to a plain confirm (the agent copilot libraries have no
	 *  module bindings to consult). */
	referenceGuard?: SkillLibraryReferenceGuard;
}
