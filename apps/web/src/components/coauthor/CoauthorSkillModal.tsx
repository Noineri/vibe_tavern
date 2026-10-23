import { SkillLibraryModal } from "../shared/skill-library/skill-library-modal.js";
import type { SkillLibraryAdapter } from "../shared/skill-library/skill-library-adapter.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useCoauthorSkillStore } from "../../stores/coauthor-skill-store.js";
import { readCoauthorSkillContent } from "../../api/skill-api.js";
import { listCoauthorModulesAction } from "../../stores/api-actions/chat-actions.js";

/** The Co-Author wrapper's i18n keys (nested `coauthor.skill.*` namespace). */
const LABELS: SkillLibraryAdapter["labels"] = {
	title: "coauthor.skill.title",
	subtitle: "coauthor.skill.subtitle",
	importCta: "coauthor.skill.import_cta",
	importing: "coauthor.skill.importing",
	importSuccess: "coauthor.skill.import_success",
	importFailed: "coauthor.skill.import_failed",
	listLabel: "coauthor.skill.list_label",
	loading: "coauthor.skill.loading",
	emptyTitle: "coauthor.skill.empty_title",
	emptyBody: "coauthor.skill.empty_body",
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
	bodyLabel: "coauthor.skill.body_label",
	showFull: "coauthor.skill.show_full",
	collapse: "coauthor.skill.collapse",
	contentLoading: "coauthor.skill.content_loading",
	techDetails: "coauthor.skill.tech_details",
	techDetailsHint: "coauthor.skill.tech_details_hint",
	filesLabel: "coauthor.skill.files_label",
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
			previewToggle: "skill-preview-toggle",
			techDetailsToggle: "skill-tech-details-toggle",
			contentBody: "skill-content-body",
		},
		entries,
		isLoading,
		hasLoaded,
		// The store's own action — already stable across renders.
		load,
		importTree,
		remove,
		// Module-level client fn — already stable across renders (satisfies
		// the adapter's `readContent` stability contract with no wrapper).
		readContent: readCoauthorSkillContent,
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
