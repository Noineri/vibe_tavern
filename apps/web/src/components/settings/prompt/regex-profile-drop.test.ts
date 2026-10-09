import { describe, expect, it } from "bun:test";
import {
  isMemberRuleDrag,
  memberRuleIdForStandaloneDrop,
  regexStandaloneDropId,
  type RegexDragItem,
} from "./regex-profile-drop.js";

const memberRule: RegexDragItem = { id: "rule-1", kind: "rule", profileId: "profile-1" };
const standaloneRule: RegexDragItem = { id: "rule-2", kind: "rule", profileId: null };
const profile: RegexDragItem = { id: "profile-1", kind: "profile", profileId: null };

describe("regex standalone drop", () => {
  it("only exposes the target for a member Rule drag", () => {
    expect(isMemberRuleDrag(null)).toBe(false);
    expect(isMemberRuleDrag(standaloneRule)).toBe(false);
    expect(isMemberRuleDrag(profile)).toBe(false);
    expect(isMemberRuleDrag(memberRule)).toBe(true);
  });

  it("returns the member Rule id only for its dedicated drop target", () => {
    expect(memberRuleIdForStandaloneDrop(memberRule, regexStandaloneDropId)).toBe("rule-1");
    expect(memberRuleIdForStandaloneDrop(memberRule, "rule-2")).toBeNull();
    expect(memberRuleIdForStandaloneDrop(standaloneRule, regexStandaloneDropId)).toBeNull();
    expect(memberRuleIdForStandaloneDrop(profile, regexStandaloneDropId)).toBeNull();
  });
});
