import { useCallback } from "react";
import { SkillLibraryModal } from "../skill-library/skill-library-modal.js";
import type { SkillLibraryAdapter } from "../skill-library/skill-library-adapter.js";
import { useCopilotSkillStore } from "../../../stores/copilot-skill-store.js";
import { readCopilotSkillContent } from "../../../api/copilot-skill-api.js";
import type { MasterDetailParentBack } from "../MasterDetailModal.js";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";
import type { AgentKind } from "../../../lib/agent-host-registry.js";

/** Empty library fallback (module const — a `?? []` inline would return a new
 * array per selector call and re-render forever under zustand's Object.is). */
const EMPTY_SKILL_ENTRIES: SkillCatalogEntryDto[] = [];

/** The agent wrapper's i18n keys (flat `copilot_skill_*` namespace). */
const LABELS: SkillLibraryAdapter["labels"] = {
	title: "copilot_skill_title",
	subtitle: "copilot_skill_subtitle",
	importCta: "copilot_skill_import_cta",
	importing: "copilot_skill_importing",
	importSuccess: "copilot_skill_import_success",
	importFailed: "copilot_skill_import_failed",
	listLabel: "copilot_skill_list_label",
	loading: "copilot_skill_loading",
	emptyTitle: "copilot_skill_empty_title",
	emptyBody: "copilot_skill_empty_body",
	emptyDetail: "copilot_skill_empty_detail",
	delete: "copilot_skill_delete",
	deleted: "copilot_skill_deleted",
	deleteFailed: "copilot_skill_delete_failed",
	deleteConfirmTitle: "copilot_skill_delete_confirm_title",
	deleteConfirmBody: "copilot_skill_delete_confirm_body",
	user: "copilot_skill_user",
	builtIn: "copilot_skill_built_in",
	shadow: "copilot_skill_shadow",
	shadowTitle: "copilot_skill_shadow_title",
	idLabel: "copilot_skill_id_label",
	manifestLabel: "copilot_skill_manifest_label",
	sourceLabel: "copilot_skill_source_label",
	bodyLabel: "copilot_skill_body_label",
	showFull: "copilot_skill_show_full",
	collapse: "copilot_skill_collapse",
	contentLoading: "copilot_skill_content_loading",
	techDetails: "copilot_skill_tech_details",
	techDetailsHint: "copilot_skill_tech_details_hint",
	filesLabel: "copilot_skill_files_label",
};

/**
 * Agent skill library manager (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 /
 * CP-10, per-kind libraries AS-8d2) — thin wrapper (AP-22): binds the shared
 * `SkillLibraryModal` to the copilot skill store for ONE agent kind. Owner
 * ruling 2026-10-17: one library per agent kind — the script editor used to
 * show the mini-app library. No reference guard — agent copilot skills have
 * no module bindings to consult, so every delete goes straight to a plain
 * confirm.
 *
 * CONTROLLED — unlike `CoauthorSkillModal` (which keys off the global
 * `modal-store`), this modal is owned by `AgentProfileModal` (opened from its
 * "Manage skills" action), so open/close AND the kind are props.
 */
export interface AgentSkillModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The agent kind whose library this instance manages (AS-8d2) — every
   *  catalog read and mutation runs under this kind only. */
  agentKind: AgentKind;
  /** Optional drill-down parent (AP-3): absent = no back link. */
  parentBack?: MasterDetailParentBack;
}

export function AgentSkillModal({ isOpen, onClose, agentKind, parentBack }: AgentSkillModalProps) {
	const entries = useCopilotSkillStore((s) => s.catalogs[agentKind]?.entries ?? EMPTY_SKILL_ENTRIES);
	const isLoading = useCopilotSkillStore((s) => s.isLoading);
	const hasLoaded = useCopilotSkillStore((s) => s.catalogs[agentKind]?.hasLoaded ?? false);
	const load = useCopilotSkillStore((s) => s.load);
	const importTree = useCopilotSkillStore((s) => s.importTree);
	const remove = useCopilotSkillStore((s) => s.remove);

	// Bound for the kind and stable across renders — the shared modal's open
	// + content effects key on `adapter.load` / `adapter.readContent` (see
	// the adapter's stability contracts).
	const loadThisKind = useCallback(() => load(agentKind), [load, agentKind]);
	const readContentThisKind = useCallback((id: string) => readCopilotSkillContent(agentKind, id), [agentKind]);

	const adapter: SkillLibraryAdapter = {
		labels: LABELS,
		testids: {
			folderInput: "copilot-skill-folder-input",
			importBtn: "copilot-skill-import-btn",
			row: (skillId) => `copilot-skill-row-${skillId}`,
			previewToggle: "copilot-skill-preview-toggle",
			techDetailsToggle: "copilot-skill-tech-details-toggle",
			contentBody: "copilot-skill-content-body",
		},
		entries,
		isLoading,
		hasLoaded,
		load: loadThisKind,
		importTree: (files) => importTree(agentKind, files),
		remove: (skillId) => remove(agentKind, skillId),
		readContent: readContentThisKind,
	};

	return <SkillLibraryModal isOpen={isOpen} onClose={onClose} adapter={adapter} parentBack={parentBack} />;
}
