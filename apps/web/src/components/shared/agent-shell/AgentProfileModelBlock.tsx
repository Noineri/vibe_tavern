import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SegmentedControl } from "../SegmentedControl.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { AgentModelPills } from "./AgentModelPills.js";
import { agentProfileModelKey, useAgentProfileModelStore } from "../../../stores/agent-profile-model-store.js";

/**
 * DR-8 (mockup §11) — a profile's own model, the model block (the `agent_profile_model_label` row) of the
 * profiles modal's read-only detail: the two-segment choice
 * sidechat | own (`agent_profile_model_mode_*`), the shared `AgentModelPills` under the own segment, and the
 * hint. Extracted from `AgentProfileModal.tsx` at the file-size ratchet.
 *
 * Rendered for CHAT-TARGET hosts only (the sidechat's profiles — the caller
 * gates it) and for built-in rows identically to user rows: the model is a
 * SETTING, not an edit (the read-only guard protects a built-in's prompt and
 * tools only; the server stores set/clear for built-in ids too).
 *
 * State is the STORED row (read through `agent-profile-model-store.ts`, the
 * one cache every own-model surface shares — the composer hook, the settings
 * subtitle, this block); writes are immediate settings:
 *  - a pill change PUTs the whole pair (provider switch without a model =
 *    `modelName` null, the provider's default at turn time);
 *  - back to the sidechat segment DELETEs (idempotent; fired on every
 *    back-click so the stored truth and the segment can never disagree);
 *  - engaging the own segment alone writes NOTHING: the pills start from the
 *    composer's current pair (`currentModel`) and the first change persists —
 *    nothing chosen, nothing stored, the next open reads the sidechat
 *    segment again.
 */
export interface AgentProfileModelBlockProps {
	/** The profile's own kind (the binding is keyed by it — built-in seed ids
	 *  are kind-scoped). */
	agentKind: string;
	profileId: string;
	/** The composer's current pair — the own-segment reveal's starting point when
	 *  nothing is stored yet. */
	currentModel?: { providerProfileId: string | null; model?: string };
	t: TFunc;
}

export function AgentProfileModelBlock({ agentKind, profileId, currentModel, t }: AgentProfileModelBlockProps) {
	const isMobile = useIsMobile();
	const loadModel = useAgentProfileModelStore((s) => s.load);
	const setModel = useAgentProfileModelStore((s) => s.set);
	const clearModel = useAgentProfileModelStore((s) => s.clear);
	const stored = useAgentProfileModelStore((s) => s.models[agentProfileModelKey(agentKind, profileId)]);
	// The own segment engaged with nothing stored yet — local until the first
	// pill change PUTs (reset when another row is selected).
	const [revealed, setRevealed] = useState(false);
	useEffect(() => {
		setRevealed(false);
		void loadModel(agentKind, profileId);
	}, [agentKind, profileId, loadModel]);

	const ownActive = stored !== undefined && stored !== null;
	const showPills = ownActive || revealed;
	const pillsProvider = ownActive ? stored.providerProfileId : (currentModel?.providerProfileId ?? null);
	const pillsModel = ownActive ? (stored.modelName ?? undefined) : currentModel?.model;

	return (
		<div data-testid="copilot-profile-model-block" className="flex flex-col items-start gap-2">
			<SegmentedControl
				ariaLabel={t("agent_profile_model_label")}
				value={showPills ? "own" : "sidechat"}
				options={[
					{ value: "sidechat", label: t("agent_profile_model_mode_sidechat") },
					{ value: "own", label: t("agent_profile_model_mode_own") },
				]}
				onChange={(next) => {
					if (next === "own") {
						setRevealed(true);
						return;
					}
					setRevealed(false);
					void clearModel(agentKind, profileId).catch(() => {
						toast.error(t("agent_binding_save_error"));
					});
				}}
			/>
			{showPills && (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<AgentModelPills
							mobile={isMobile}
							providerProfileId={pillsProvider}
							model={pillsModel}
							onProviderChange={(providerProfileId, nextModel) => {
								void setModel(agentKind, profileId, {
									providerProfileId,
									...(nextModel !== undefined ? { modelName: nextModel } : {}),
								}).catch(() => {
									toast.error(t("agent_binding_save_error"));
								});
							}}
						/>
					</div>
					<p
						data-testid="copilot-profile-model-hint"
						className="font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3"
					>
						{t("agent_profile_model_hint")}
					</p>
				</>
			)}
		</div>
	);
}
