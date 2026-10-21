/**
 * `canDeleteActiveBranch` — the one «can the active branch be deleted» rule
 * shared by the desktop sidebar row, its flyout and the character-chats panel
 * (RAIL_DRILL_IN RD-2). Pure logic, no doubles.
 */
import { describe, expect, it } from "bun:test";
import { brandId, type ChatBranchId } from "@vibe-tavern/domain";
import { canDeleteActiveBranch } from "./sidebar-utils.js";

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
