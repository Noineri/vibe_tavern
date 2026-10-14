import { createElement, useCallback, useRef, useState, type ReactNode } from "react";
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import type { AgentHostBridge } from "../../../../lib/agent-host-registry.js";
import type { CopilotDigest } from "../../../../lib/experience-copilot-digest.js";
import type { CopilotBufferReview } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import type { TFunc } from "../../../../i18n/locale-helpers.js";
import { allReviewHunkIds } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import { buildExperienceCopilotReviewSnapshot } from "../../../../lib/experience-copilot-review-snapshot.js";
import { agentThreadKey, type AgentKind } from "../../../../lib/agent-host-registry.js";
import { useAgentReviewOutcomeStore } from "../../../../stores/agent-review-outcome-store.js";

/** Cohesive host extraction: turn-local review feedback sent alongside a turn. */
export function useExperienceCopilotReviewFeedback({
  bridge,
  onCopied,
}: {
  bridge: AgentHostBridge;
  onCopied: () => void;
}) {
  const [testFeedback, setTestFeedback] = useState<Record<string, unknown> | undefined>(undefined);
  const launchContextRef = useRef<ExperienceCopilotLaunchContext | undefined>(undefined);
  const handleLaunchContextChange = useCallback((context: ExperienceCopilotLaunchContext) => {
    launchContextRef.current = context;
  }, []);
  const handleSendToCopilot = useCallback((digest: CopilotDigest) => {
    setTestFeedback(digest.feedback);
    bridge.setInputPrefill({ text: digest.text });
    onCopied();
  }, [bridge, onCopied]);
  return { testFeedback, launchContextRef, handleLaunchContextChange, handleSendToCopilot };
}

/** Review badges are host-owned presentation state, kept beside its metadata flow. */
export function useExperienceCopilotReviewTabs({
  rulesReview,
  visualReview,
  t,
}: {
  rulesReview: CopilotBufferReview | null;
  visualReview: CopilotBufferReview | null;
  t: TFunc;
}) {
  const tabLabel = (value: "rules" | "visual", label: string): ReactNode => {
    const pending = value === "rules" ? rulesReview !== null : visualReview !== null;
    if (!pending) return label;
    return createElement("span", { className: "inline-flex items-center gap-1.5" }, label, createElement("span", { "data-testid": `copilot-buffer-dot-${value}`, title: t("copilot_review_pending_badge"), className: "h-1.5 w-1.5 rounded-full bg-accent" }));
  };
  const codeTabLabel = rulesReview !== null || visualReview !== null
    ? createElement("span", { className: "inline-flex items-center gap-1.5" }, t("agent_code"), createElement("span", { "data-testid": "copilot-outer-dot-code", title: t("copilot_review_pending_badge"), className: "h-1.5 w-1.5 rounded-full bg-accent" }))
    : t("agent_code");
  return {
    outerBufferOptions: [{ value: "preview", label: t("agent_preview") }, { value: "code", label: codeTabLabel }, { value: "sandbox", label: t("agent_try_it") }],
    codeBufferOptions: [{ value: "rules", label: tabLabel("rules", t("agent_rules")) }, { value: "visual", label: tabLabel("visual", t("agent_visual")) }],
  };
}

/** Records a successful local buffer application with all prior applied hunks for the round. */
export function recordExperienceAppliedOutcome({ kind, threadId, target, bufferReview, accepted, dismissed, applied, cancelled = false }: {
  kind: AgentKind;
  threadId: string;
  target: "rules" | "visual";
  bufferReview: CopilotBufferReview;
  accepted: ReadonlySet<number>;
  dismissed: ReadonlySet<number>;
  applied: ReadonlySet<number>;
  cancelled?: boolean;
}): void {
  const prior = useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(kind, threadId)]?.[target];
  const appliedHunkIds = new Set([...prior?.appliedHunkIds ?? [], ...applied]);
  const [record] = buildExperienceCopilotReviewSnapshot([{
    target,
    base: bufferReview.base,
    proposed: bufferReview.proposed,
    offeredHunkIds: [...allReviewHunkIds(bufferReview)],
    acceptedHunkIds: accepted,
    dismissedHunkIds: dismissed,
    appliedHunkIds,
    cancelled,
  }]).targets;
  if (record) useAgentReviewOutcomeStore.getState().record(kind, threadId, record, [...appliedHunkIds]);
}
