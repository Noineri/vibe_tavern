import type { AiInstructionTemplateRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type {
	AiInstructionTemplate,
	AiInstructionTemplateCreate,
	AiInstructionTemplateList,
	AiInstructionTemplateUpdate,
} from "@vibe-tavern/api-contracts";
import { conflict, validation } from "../../shared/errors.js";

/**
 * Thin adapter between the `AiInstructionTemplateRuntimeApi` contract and the
 * `@vibe-tavern/db` aiInstructionTemplates store
 * (AI_EDITOR_INSTRUCTION_TEMPLATES). A file-by-file fork of
 * FormatTemplateAdapter: pure CRUD + the name-collision rule shared by create
 * / rename (409 Conflict via the case-insensitive probe). Named deviation
 * from the twin: the payload is a plain string, so there is no JSON parse /
 * validation half — the wire record maps 1:1 onto the store row.
 */
export class AiInstructionTemplateAdapter implements AiInstructionTemplateRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listAiInstructionTemplates = async (): Promise<AiInstructionTemplateList> => {
		return await this.stores.aiInstructionTemplates.list();
	};

	createAiInstructionTemplate = async (input: AiInstructionTemplateCreate): Promise<AiInstructionTemplate> => {
		await assertNameAvailable(this.stores, input.name, null);
		return await this.stores.aiInstructionTemplates.create({ name: input.name, text: input.text });
	};

	updateAiInstructionTemplate = async (id: string, input: AiInstructionTemplateUpdate): Promise<AiInstructionTemplate> => {
		const existing = await this.stores.aiInstructionTemplates.getById(id);
		if (!existing) {
			throw validation(`AI instruction template '${id}' was not found.`);
		}
		if (input.name !== undefined && input.name !== existing.name) {
			await assertNameAvailable(this.stores, input.name, id);
		}
		return await this.stores.aiInstructionTemplates.update(id, input);
	};

	deleteAiInstructionTemplate = async (id: string): Promise<void> => {
		await this.stores.aiInstructionTemplates.delete(id);
	};
}

/** Case-insensitive name-collision probe shared by create / rename — the same
 *  rule the format-template adapter applies (the LS-5 pattern). */
async function assertNameAvailable(stores: StoreContainer, name: string, selfId: string | null): Promise<void> {
	const trimmed = name.trim().toLowerCase();
	const rows = await stores.aiInstructionTemplates.list();
	const existing = rows.find((row) => row.name.trim().toLowerCase() === trimmed && row.id !== selfId);
	if (existing) {
		throw conflict(`An AI instruction template named '${name.trim()}' already exists.`, { aiInstructionTemplateId: existing.id });
	}
}
