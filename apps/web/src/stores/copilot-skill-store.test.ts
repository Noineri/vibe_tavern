import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";
import type { AgentKind } from "../lib/agent-host-registry.js";

const reorderCopilotSkills = mock(
	(_kind: AgentKind, _updates: Array<{ id: string; sortOrder: number }>) =>
		Promise.resolve({ entries: [] as SkillCatalogEntryDto[], errors: [] }),
);

const realCopilotSkillApi = await import("../api/copilot-skill-api.js");
mock.module("../api/copilot-skill-api.js", () => ({
	...realCopilotSkillApi,
	reorderCopilotSkills,
}));

const { useCopilotSkillStore } = await import("./copilot-skill-store.js");

function entry(id: string, source: "builtin" | "user"): SkillCatalogEntryDto {
	return {
		id,
		source,
		name: id,
		description: `${id} desc`,
		manifestPath: `${id}/SKILL.md`,
		shadowsBuiltin: false,
	};
}

const KIND = "experience" as AgentKind;
const OTHER_KIND = "script" as AgentKind;

beforeEach(() => {
	useCopilotSkillStore.setState({
		catalogs: {
			[KIND]: { entries: [entry("b1", "builtin"), entry("u1", "user")], errors: [], hasLoaded: true },
			[OTHER_KIND]: { entries: [entry("other", "builtin")], errors: [], hasLoaded: true },
		},
		isLoading: false,
	});
	reorderCopilotSkills.mockReset();
	reorderCopilotSkills.mockImplementation(() =>
		Promise.resolve({ entries: [] as SkillCatalogEntryDto[], errors: [] }),
	);
});

describe("copilot-skill-store — reorder (ML-9)", () => {
	it("sends the kind + full new order and adopts the refreshed kind catalog", async () => {
		const refreshed = [entry("u1", "user"), entry("b1", "builtin")];
		reorderCopilotSkills.mockImplementation(() => Promise.resolve({ entries: refreshed, errors: [] }));

		await useCopilotSkillStore.getState().reorder(KIND, [
			{ id: "u1", sortOrder: 0 },
			{ id: "b1", sortOrder: 1 },
		]);

		expect(reorderCopilotSkills).toHaveBeenCalledTimes(1);
		expect(reorderCopilotSkills.mock.calls[0]?.[0]).toBe(KIND);
		expect(reorderCopilotSkills.mock.calls[0]?.[1]).toEqual([
			{ id: "u1", sortOrder: 0 },
			{ id: "b1", sortOrder: 1 },
		]);
		expect(useCopilotSkillStore.getState().catalogs[KIND]?.entries).toEqual(refreshed);
		// The other kind's library is untouched (order is per library).
		expect(useCopilotSkillStore.getState().catalogs[OTHER_KIND]?.entries.map((e) => e.id)).toEqual([
			"other",
		]);
	});

	it("a rejected reorder leaves the kind catalog untouched", async () => {
		reorderCopilotSkills.mockImplementation(() => Promise.reject(new Error("nope")));

		await expect(
			useCopilotSkillStore.getState().reorder(KIND, [{ id: "u1", sortOrder: 0 }]),
		).rejects.toThrow("nope");
		expect(useCopilotSkillStore.getState().catalogs[KIND]?.entries.map((e) => e.id)).toEqual([
			"b1",
			"u1",
		]);
	});
});
