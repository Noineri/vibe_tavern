export const regexStandaloneDropId = "regex:standalone";

export interface RegexDragItem {
  id: string;
  kind: "profile" | "rule";
  profileId: string | null;
}

export function memberRuleIdForStandaloneDrop(
  activeItem: RegexDragItem | null,
  overId: string | null | undefined,
): string | null {
  if (overId !== regexStandaloneDropId) return null;
  if (activeItem?.kind !== "rule" || activeItem.profileId === null) return null;
  return activeItem.id;
}

export function isMemberRuleDrag(activeItem: RegexDragItem | null): boolean {
  return activeItem?.kind === "rule" && activeItem.profileId !== null;
}
