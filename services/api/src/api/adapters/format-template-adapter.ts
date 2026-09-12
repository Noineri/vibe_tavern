import type { FormatTemplateRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type {
	FormatTemplate,
	FormatTemplateCreate,
	FormatTemplateList,
	FormatTemplateUpdate,
} from "@vibe-tavern/api-contracts";
import { conflict, validation } from "../../shared/errors.js";

/**
 * Thin adapter between the `FormatTemplateRuntimeApi` contract and the
 * `@vibe-tavern/db` formatTemplates store (LOCAL_SUPPORT_PLAN LS-10). Mirrors
 * the SamplerSetAdapter role: pure CRUD over the store + the name-collision
 * rule shared by create / rename (409 Conflict via `getByName`), so the
 * format pane's inline warning and the HTTP layer agree. Templates are inert
 * (the pane copies sequences into the profile format — no live binding), so
 * delete needs no reference cleanup beyond profiles whose SELECTION points at
 * the deleted id: their selection falls back to "backend" semantics at
 * resolution (a missing payload degrades to auto + a warning, never to a
 * broken generation).
 */
export class FormatTemplateAdapter implements FormatTemplateRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listFormatTemplates = async (): Promise<FormatTemplateList> => {
		const rows = await this.stores.formatTemplates.list();
		return rows.map(formatTemplateRowToWire);
	};

	createFormatTemplate = async (input: FormatTemplateCreate): Promise<FormatTemplate> => {
		await assertNameAvailable(this.stores, input.name, null);
		return formatTemplateRowToWire(await this.stores.formatTemplates.create({ name: input.name, payload: input.payload }));
	};

	updateFormatTemplate = async (id: string, input: FormatTemplateUpdate): Promise<FormatTemplate> => {
		const existing = await this.stores.formatTemplates.getById(id);
		if (!existing) {
			throw validation(`Format template '${id}' was not found.`);
		}
		if (input.name !== undefined && input.name !== existing.name) {
			await assertNameAvailable(this.stores, input.name, id);
		}
		return formatTemplateRowToWire(await this.stores.formatTemplates.update(id, input));
	};

	deleteFormatTemplate = async (id: string): Promise<void> => {
		await this.stores.formatTemplates.delete(id);
	};
}

/** Map a store row onto the wire shape. The payload crosses a type-erased
 *  boundary (the DB store holds untyped JSON); its shape is validated by the
 *  zod schema at the adapter boundary on every write (create/update), so the
 *  read-side projection trusts the record. */
function formatTemplateRowToWire(row: {
	id: string;
	name: string;
	sortOrder: number;
	payload: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}): FormatTemplate {
	return {
		id: row.id,
		name: row.name,
		sortOrder: row.sortOrder,
		payload: row.payload as FormatTemplate["payload"],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Case-insensitive name-collision probe shared by create / rename — the same
 *  rule the pane's inline warning applies client-side (the LS-5 pattern). */
async function assertNameAvailable(stores: StoreContainer, name: string, selfId: string | null): Promise<void> {
	const trimmed = name.trim().toLowerCase();
	const rows = await stores.formatTemplates.list();
	const existing = rows.find((row) => row.name.trim().toLowerCase() === trimmed && row.id !== selfId);
	if (existing) {
		throw conflict(`A format template named '${name.trim()}' already exists.`, { formatTemplateId: existing.id });
	}
}
