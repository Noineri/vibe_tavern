import type { Dispatch, SetStateAction } from "react";
import type { RegexPresetRecord } from "../../../api/types.js";

interface RegexProfileAssignmentHost {
  attach: (profileId: string, ruleId: string) => Promise<RegexPresetRecord | null>;
  detach: (ruleId: string) => Promise<RegexPresetRecord | null>;
  setRules: Dispatch<SetStateAction<RegexPresetRecord[]>>;
  setExpandedProfileIds: Dispatch<SetStateAction<Set<string>>>;
  onConfirmed: () => void;
  onFailed: () => void;
}

/** Applies Profile membership only after the attach/detach endpoint confirms the Rule. */
export function makeRegexProfileAssignmentHandler(host: RegexProfileAssignmentHost) {
  async function assign(ruleId: string, profileId: string | null) {
    try {
      const updated = profileId
        ? await host.attach(profileId, ruleId)
        : await host.detach(ruleId);
      if (!updated) throw new Error("Regex Rule membership update was not confirmed.");
      host.setRules((rules) => rules.map((rule) => rule.id === updated.id ? updated : rule));
      if (profileId) host.setExpandedProfileIds((expanded) => new Set([...expanded, profileId]));
      host.onConfirmed();
    } catch {
      host.onFailed();
    }
  }

  return { assign, detach: (ruleId: string) => assign(ruleId, null) };
}
