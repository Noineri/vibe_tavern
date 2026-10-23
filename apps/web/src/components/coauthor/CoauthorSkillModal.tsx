import { SkillLibraryModal } from "../shared/skill-library/skill-library-modal.js";
import type { SkillLibraryAdapter } from "../shared/skill-library/skill-library-adapter.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useCoauthorSkillStore } from "../../stores/coauthor-skill-store.js";
import { listCoauthorModulesAction } from "../../stores/api-actions/chat-actions.js";

/** The Co-Author wrapper's i18n keys (nested `coauthor.skill.*` namespace). */
const LABELS: SkillLibraryAdapter["labels"] = {
	title: "coauthor.skill.title",
	subtitle: "coauthor.skill.subtitle",
	close: "coauthor.skill.close",
	import: "coauthor.skill.import",
	importing: "coauthor.skill.importing",
	importSuccess: "coauthor.skill.import_success",
	importFailed: "coauthor.skill.import_failed",
	listLabel: "coauthor.skill.list_label",
	loading: "coauthor.skill.loading",
	empty: "coauthor.skill.empty",
	emptySub: "coauthor.skill.empty_sub",
	emptyDetail: "coauthor.skill.empty_detail",
	delete: "coauthor.skill.delete",
	deleted: "coauthor.skill.deleted",
	deleteFailed: "coauthor.skill.delete_failed",
	deleteConfirmTitle: "coauthor.skill.delete_confirm_title",
	deleteConfirmBody: "coauthor.skill.delete_confirm_body",
	user: "coauthor.skill.user",
	builtIn: "coauthor.skill.built_in",
	shadow: "coauthor.skill.shadow",
	shadowTitle: "coauthor.skill.shadow_title",
	idLabel: "coauthor.skill.id_label",
	manifestLabel: "coauthor.skill.manifest_label",
	sourceLabel: "coauthor.skill.source_label",
	inspectHint: "coauthor.skill.inspect_hint",
};

/**
 * CTX-S7 — Co-Author skill library manager: thin wrapper (AP-22) binding the
 * shared `SkillLibraryModal` to the global modal-store flag and the Co-Author
 * skill catalog store. Deleting a skill that modules still reference opens a
 * confirm that LISTS those modules (the reference guard) instead of silently
 * leaving broken bindings — the guard is data-driven (modules referencing a
 * skill), so it rides the adapter.
 */
export function CoauthorSkillModal() {
	const isOpen = useModalStore((s) => s.isCoauthorSkillModalOpen);
	const setIsOpen = useModalStore((s) => s.setCoauthorSkillModalOpen);

	const entries = useCoauthorSkillStore((s) => s.entries);
	const isLoading = useCoauthorSkillStore((s) => s.isLoading);
	const hasLoaded = useCoauthorSkillStore((s) => s.hasLoaded);
	const load = useCoauthorSkillStore((s) => s.load);
	const importTree = useCoauthorSkillStore((s) => s.importTree);
	const remove = useCoauthorSkillStore((s) => s.remove);

	const adapter: SkillLibraryAdapter = {
		labels: LABELS,
		testids: {
			folderInput: "skill-folder-input",
			importBtn: "skill-import-btn",
			deleteBtn: (skillId) => `skill-delete-btn-${skillId}`,
			detailDeleteBtn: "skill-detail-delete-btn",
		},
		entries,
		isLoading,
		hasLoaded,
		// The store's own action — already stable across renders.
		load,
		importTree,
		remove,
		referenceGuard: {
			findReferencingModules: async (skillId) => {
				const modules = await listCoauthorModulesAction();
				return modules
					.filter((m) => m.skillIds.includes(skillId))
					.map((m) => m.name);
			},
			referencedBody: "coauthor.skill.delete_referenced_body",
			referencedHint: "coauthor.skill.delete_referenced_hint",
		},
	};

	return (
		<SkillLibraryModal
			isOpen={isOpen}
			onClose={() => setIsOpen(false)}
			adapter={adapter}
		/>
	);
}
