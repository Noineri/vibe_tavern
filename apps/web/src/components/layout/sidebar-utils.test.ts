/**
 * `canDeleteActiveBranch` — the one «can the active branch be deleted» rule
 * shared by the desktop sidebar row, its flyout and the character-chats panel
 * (RAIL_DRILL_IN RD-2) — and the rail's «N chats · when» summary helpers
 * (RD-3). Pure logic, no doubles.
 */
import { describe, expect, it } from "bun:test";
import { brandId, type ChatBranchId, type CharacterId } from "@vibe-tavern/domain";
import { canDeleteActiveBranch, summarizeCharacterChats, summarizeChatsByCharacter } from "./sidebar-utils.js";

const ROOT = brandId<ChatBranchId>("br-root");
const SIDE_A = brandId<ChatBranchId>("br-side-a");
const SIDE_B = brandId<ChatBranchId>("br-side-b");

const root = { id: ROOT, parentBranchId: null };
const sideA = { id: SIDE_A, parentBranchId: ROOT };
const sideB = { id: SIDE_B, parentBranchId: ROOT };

describe("canDeleteActiveBranch", () => {
	it("allows deleting a side branch while other branches exist", () => {
		expect(canDeleteActiveBranch([root, sideA, sideB], SIDE_A)).toBe(true);
		expect(canDeleteActiveBranch([root, sideA], SIDE_A)).toBe(true);
	});

	it("never allows deleting the root branch, however many branches exist", () => {
		expect(canDeleteActiveBranch([root, sideA, sideB], ROOT)).toBe(false);
		expect(canDeleteActiveBranch([sideA, root], ROOT)).toBe(false);
	});

	it("never allows deleting when there is only one branch", () => {
		expect(canDeleteActiveBranch([root], ROOT)).toBe(false);
		// A lone non-root branch (no root in the list) is still «only one branch».
		expect(canDeleteActiveBranch([sideA], SIDE_A)).toBe(false);
	});

	it("allows a side branch even when the list carries no root (the root is only forbidden when found)", () => {
		expect(canDeleteActiveBranch([sideA, sideB], SIDE_A)).toBe(true);
	});

	it("with no active branch the root test cannot match: more than one branch means deletable", () => {
		expect(canDeleteActiveBranch([root, sideA], null)).toBe(true);
		expect(canDeleteActiveBranch([root], null)).toBe(false);
		expect(canDeleteActiveBranch([], null)).toBe(false);
	});
});

describe("summarizeCharacterChats", () => {
	it("counts the chats and reports the newest updatedAt", () => {
		const summary = summarizeCharacterChats([
			{ updatedAt: "2026-03-01T10:00:00.000Z" },
			{ updatedAt: "2026-05-01T10:00:00.000Z" },
			{ updatedAt: "2026-04-01T10:00:00.000Z" },
		]);
		expect(summary).toEqual({ count: 3, newestUpdatedAt: "2026-05-01T10:00:00.000Z" });
	});

	it("no chats: count 0 and no timestamp", () => {
		expect(summarizeCharacterChats([])).toEqual({ count: 0, newestUpdatedAt: null });
	});

	it("compares instants, not strings (different offsets of the same wall clock)", () => {
		// 12:00+05:00 is 07:00Z — earlier than 09:00Z although it sorts later as text.
		const summary = summarizeCharacterChats([{ updatedAt: "2026-05-01T12:00:00.000+05:00" }, { updatedAt: "2026-05-01T09:00:00.000Z" }]);
		expect(summary.newestUpdatedAt).toBe("2026-05-01T09:00:00.000Z");
	});

	it("an unparsable timestamp still counts as a chat but never wins as the newest", () => {
		expect(summarizeCharacterChats([{ updatedAt: "not a date" }, { updatedAt: "2026-05-01T09:00:00.000Z" }])).toEqual({
			count: 2,
			newestUpdatedAt: "2026-05-01T09:00:00.000Z",
		});
		expect(summarizeCharacterChats([{ updatedAt: "not a date" }])).toEqual({ count: 1, newestUpdatedAt: null });
	});
});

describe("summarizeChatsByCharacter", () => {
	const aria = brandId<CharacterId>("char-aria");
	const bram = brandId<CharacterId>("char-bram");

	it("groups per character, each summary equal to summarizeCharacterChats of its own chats", () => {
		const chats = [
			{ characterId: aria, updatedAt: "2026-05-01T09:00:00.000Z" },
			{ characterId: bram, updatedAt: "2026-02-01T09:00:00.000Z" },
			{ characterId: aria, updatedAt: "2026-06-01T09:00:00.000Z" },
		];
		const summaries = summarizeChatsByCharacter(chats);
		expect(summaries.get(aria)).toEqual({ count: 2, newestUpdatedAt: "2026-06-01T09:00:00.000Z" });
		expect(summaries.get(bram)).toEqual({ count: 1, newestUpdatedAt: "2026-02-01T09:00:00.000Z" });
		expect(summaries.get(aria)).toEqual(summarizeCharacterChats(chats.filter((c) => c.characterId === aria)));
	});

	it("a character with no chats has no entry", () => {
		const summaries = summarizeChatsByCharacter([{ characterId: aria, updatedAt: "2026-05-01T09:00:00.000Z" }]);
		expect(summaries.has(bram)).toBe(false);
		expect(summarizeChatsByCharacter([]).size).toBe(0);
	});
});
