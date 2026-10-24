import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";

const reorderCoauthorSkills = mock(
	(_updates: Array<{ id: string; sortOrder: number }>) =>
		Promise.resolve({ entries: [] as SkillCatalogEntryDto[], errors: [] }),
);

const realSkillApi = await import("../api/skill-api.js");
mock.module("../api/skill-api.js", () => ({
	...realSkillApi,
	reorderCoauthorSkills,
}));

const { useCoauthorSkillStore } = await import("./coauthor-skill-store.js");

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

beforeEach(() => {
	useCoauthorSkillStore.setState({
		entries: [entry("b1", "builtin"), entry("u1", "user")],
		errors: [],
		isLoading: false,
		hasLoaded: true,
	});
	reorderCoauthorSkills.mockReset();
	reorderCoauthorSkills.mockImplementation(() =>
		Promise.resolve({ entries: [] as SkillCatalogEntryDto[], errors: [] }),
	);
});

describe("coauthor-skill-store — reorder (ML-9)", () => {
	it("sends the full new order and adopts the refreshed catalog", async () => {
		const refreshed = [entry("u1", "user"), entry("b1", "builtin")];
		reorderCoauthorSkills.mockImplementation(() => Promise.resolve({ entries: refreshed, errors: [] }));

		await useCoauthorSkillStore.getState().reorder([
			{ id: "u1", sortOrder: 0 },
			{ id: "b1", sortOrder: 1 },
		]);

		expect(reorderCoauthorSkills).toHaveBeenCalledTimes(1);
		expect(reorderCoauthorSkills.mock.calls[0]?.[0]).toEqual([
			{ id: "u1", sortOrder: 0 },
			{ id: "b1", sortOrder: 1 },
		]);
		expect(useCoauthorSkillStore.getState().entries).toEqual(refreshed);
	});

	it("a rejected reorder leaves the entries untouched", async () => {
		reorderCoauthorSkills.mockImplementation(() => Promise.reject(new Error("nope")));

		await expect(
			useCoauthorSkillStore.getState().reorder([{ id: "u1", sortOrder: 0 }]),
		).rejects.toThrow("nope");
		expect(useCoauthorSkillStore.getState().entries.map((e) => e.id)).toEqual(["b1", "u1"]);
	});
});
