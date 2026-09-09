import type { SamplerSetRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type {
	SamplerSet,
	SamplerSetCreate,
	SamplerSetImport,
	SamplerSetList,
	SamplerSetUpdate,
} from "@vibe-tavern/api-contracts";
import { samplerPresetPayloadSchema } from "@vibe-tavern/api-contracts";
import { isStTextgenShape, parseStTextgen } from "@vibe-tavern/import-export";
import { conflict, validation } from "../../shared/errors.js";

/**
 * Thin adapter between the `SamplerSetRuntimeApi` contract and the
 * `@vibe-tavern/db` samplerSets store (LOCAL_SUPPORT_PLAN LS-5b). Mirrors the
 * CopilotProfileAdapter role: pure CRUD over the store + the import sniff
 * (VT-native set JSON vs ST TextGen Settings file → parseStTextgen mapping).
 *
 * Name collisions are resolved HERE (409 Conflict via `getByName`) so the
 * panel's inline warning and the HTTP layer share one rule. Delete clears the
 * deleted set's provider_profiles.sampler_set_id references first (LS-5e —
 * the column is deliberately FK-less; see db-schema).
 */
export class SamplerSetAdapter implements SamplerSetRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listSamplerSets = async (): Promise<SamplerSetList> => {
		const rows = await this.stores.samplerSets.list();
		return rows.map(samplerSetRowToWire);
	};

	createSamplerSet = async (input: SamplerSetCreate): Promise<SamplerSet> => {
		await assertNameAvailable(this.stores, input.name, null);
		return samplerSetRowToWire(await this.stores.samplerSets.create({ name: input.name, payload: input.payload }));
	};

	updateSamplerSet = async (id: string, input: SamplerSetUpdate): Promise<SamplerSet> => {
		const existing = await this.stores.samplerSets.getById(id);
		if (!existing) {
			throw validation(`Sampler set '${id}' was not found.`);
		}
		if (input.name !== undefined && input.name !== existing.name) {
			await assertNameAvailable(this.stores, input.name, id);
		}
		return samplerSetRowToWire(await this.stores.samplerSets.update(id, input));
	};

	deleteSamplerSet = async (id: string): Promise<void> => {
		// Clear dangling references BEFORE the row disappears (LS-5e: deleting a
		// set never leaves profiles pointing at a ghost; the values they applied
		// stay — copy-on-select, sets are inert templates).
		await this.stores.providers.clearSamplerSetReference(id);
		await this.stores.samplerSets.delete(id);
	};

	importSamplerSet = async (
		input: SamplerSetImport,
	): Promise<{ set: SamplerSet; notes: string[] }> => {
		await assertNameAvailable(this.stores, input.name, null);

		// Sniff (LS-5g): ST TextGen files carry snake_case ooba keys VT never
		// writes, so the ST sniff is checked FIRST — an ST file would otherwise
		// pass the all-optional VT overlay schema as an (wrong) empty payload.
		if (isStTextgenShape(input.raw)) {
			const parsed = parseStTextgen(input.raw);
			if (!parsed) {
				throw validation("The file does not contain a valid sampler set.");
			}
			const created = await this.stores.samplerSets.create({ name: input.name, payload: parsed.payload });
			return { set: samplerSetRowToWire(created), notes: parsed.notes };
		}

		const vt = samplerPresetPayloadSchema.safeParse(input.raw);
		if (!vt.success || Object.keys(vt.data).length === 0) {
			// The all-optional overlay schema would accept ANY object as an (empty)
			// set — a random JSON file or a {name, payload} wrapper must fail loudly,
			// not land as a silently empty set.
			throw validation("The file does not contain a valid sampler set (neither a VT-native set nor an ST TextGen preset).");
		}
		const created = await this.stores.samplerSets.create({ name: input.name, payload: vt.data });
		return { set: samplerSetRowToWire(created), notes: [] };
	};
}

/** Map a store row onto the wire shape (the payload is already a parsed record). */
function samplerSetRowToWire(row: {
	id: string;
	name: string;
	sortOrder: number;
	payload: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}): SamplerSet {
	return {
		id: row.id,
		name: row.name,
		sortOrder: row.sortOrder,
		payload: row.payload,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Case-insensitive name-collision probe shared by create / rename / import —
 *  the same rule the panel's inline warning applies client-side
 *  (ProviderEditHeader duplicateNameWarning: trim + lowercase compare). */
async function assertNameAvailable(stores: StoreContainer, name: string, selfId: string | null): Promise<void> {
	const trimmed = name.trim().toLowerCase();
	const rows = await stores.samplerSets.list();
	const existing = rows.find((row) => row.name.trim().toLowerCase() === trimmed && row.id !== selfId);
	if (existing) {
		throw conflict(`A sampler set named '${name.trim()}' already exists.`, { samplerSetId: existing.id });
	}
}
