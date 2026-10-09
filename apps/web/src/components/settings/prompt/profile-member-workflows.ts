import type { Dispatch, SetStateAction } from "react";
import type { RegexPresetRecord } from "../../../api/types.js";

interface RegexProfileAttachmentHost {
  attach: (profileId: string, ruleId: string) => Promise<RegexPresetRecord | null>;
  setRules: Dispatch<SetStateAction<RegexPresetRecord[]>>;
  setExpandedProfileIds: Dispatch<SetStateAction<Set<string>>>;
  onAttached: () => void;
}

/** Reuses the existing attachment operation for one or more standalone Rules. */
export function makeRegexProfileAttachmentHandler(host: RegexProfileAttachmentHost) {
  return (profileId: string, ruleIds: string | string[]) => {
    const ids = Array.isArray(ruleIds) ? ruleIds : [ruleIds];
    void Promise.all(ids.map((ruleId) => host.attach(profileId, ruleId))).then((updatedRules) => {
      host.setRules((rules) => rules.map((rule) => updatedRules.find((updated) => updated?.id === rule.id) ?? rule));
      host.setExpandedProfileIds((expanded) => new Set([...expanded, profileId]));
      host.onAttached();
    });
  };
}
