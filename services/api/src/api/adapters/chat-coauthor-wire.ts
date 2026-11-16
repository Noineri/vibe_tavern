/**
 * Co-Author wire helpers for the chat adapter (extracted from
 * chat-adapter.ts at the arch-gate size cap — DMT-24's additions left the
 * file no headroom under the 800-line gate). Pure mapping/refusal helpers
 * with no adapter state: the stable `COAUTHOR_MODEL_REQUIRED` code, the
 * fail-closed missing-connection error, and the stored-user-module → wire
 * projection.
 */

import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { validation } from "../../shared/errors.js";

export const COAUTHOR_MODEL_REQUIRED_CODE = "coauthor_model_required";

/** Stable fail-closed error for missing or dangling Co-Author connections.
 * CG-4 maps this code to the Co-Author model-selection state. */
export function coauthorModelRequired() {
	return validation("Choose a model for the Co-Author.", { code: COAUTHOR_MODEL_REQUIRED_CODE });
}

/** Map a stored user-module row to the API `CoauthorModule` shape: drop the
 * DB-only timestamps, stamp `isBuiltIn: false` (user modules are editable). */
export function toCoauthorModule(row: {
	id: string;
	name: string;
	description: string;
	basePrompt: string;
	openingMessage: string;
	skillIds: string[];
	toolSet: CoauthorModule["toolSet"];
	maxSteps: number;
	createdAt: string;
	updatedAt: string;
}): CoauthorModule {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		basePrompt: row.basePrompt,
		openingMessage: row.openingMessage,
		skillIds: row.skillIds,
		toolSet: row.toolSet,
		maxSteps: row.maxSteps,
		isBuiltIn: false,
	};
}
