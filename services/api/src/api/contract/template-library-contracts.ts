import type {
	AiInstructionTemplate,
	AiInstructionTemplateCreate,
	AiInstructionTemplateList,
	AiInstructionTemplateUpdate,
	FormatTemplate,
	FormatTemplateCreate,
	FormatTemplateList,
	FormatTemplateUpdate,
} from "@vibe-tavern/api-contracts";

/**
 * Runtime contracts for the two template libraries (extracted from
 * runtime-api.ts for its size ratchet — the catalog had grown past its
 * baseline; both interfaces moved here verbatim and are re-exported from the
 * catalog so existing importers are untouched).
 *
 * Both are the small-resource CRUD shape (the SamplerSetRuntimeApi pattern):
 * list / create / update / delete over a user-saved named library, with the
 * name-collision rule (409) living in the adapters.
 */

/** Named custom format templates (LOCAL_SUPPORT_PLAN LS-10) — the small-resource
 *  CRUD pattern (SamplerSetRuntimeApi minus the import endpoint; ST instruct
 *  import lands through the pane's own file picker, not a raw-JSON route). */
export interface FormatTemplateRuntimeApi {
	listFormatTemplates: () => Promise<FormatTemplateList>;
	createFormatTemplate: (input: FormatTemplateCreate) => Promise<FormatTemplate>;
	updateFormatTemplate: (id: string, input: FormatTemplateUpdate) => Promise<FormatTemplate>;
	deleteFormatTemplate: (id: string) => Promise<void>;
}

/** User-saved instruction templates for the message AI editor
 *  (AI_EDITOR_INSTRUCTION_TEMPLATES) — the format-template CRUD shape with a
 *  plain text payload: recurring edit/merge instructions stored by name. */
export interface AiInstructionTemplateRuntimeApi {
	listAiInstructionTemplates: () => Promise<AiInstructionTemplateList>;
	createAiInstructionTemplate: (input: AiInstructionTemplateCreate) => Promise<AiInstructionTemplate>;
	updateAiInstructionTemplate: (id: string, input: AiInstructionTemplateUpdate) => Promise<AiInstructionTemplate>;
	deleteAiInstructionTemplate: (id: string) => Promise<void>;
}
