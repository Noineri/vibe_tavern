// Shared data layer for the co-author input area. Both the desktop branch
// (CoauthorInputArea.tsx's DesktopInput) and the mobile branch
// (CoauthorMobileInputArea.tsx) consume the same controllers / store reads /
// tool-filtered favorites / token buckets so that the viewport fork stays a
// pure presentational split — mirroring the RP InputArea fork (b4e0aa5f).
//
// This hook is "everything the old CoauthorInputArea() body computed before
// the `if (isMobile)` check", formalised. UI-only state (dropdown open-flags,
// the mobile textarea auto-grow ref) is co-located with the branch that owns
// it; this hook holds only data + behaviour shared by both.
//
// useModuleSwitch is co-exported here because it is co-author-input-specific
// (reads the snapshot store's active chat + the module registry action), is
// consumed by BOTH branches, and has no JSX — a clean fit next to the data
// hook rather than in its own file.

import { useEffect, useMemo, useState } from "react";
import type { PromptLayerDto } from "@vibe-tavern/domain";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCoauthorProviderBinding } from "../../hooks/use-coauthor-provider-binding.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useChatStore, useProviderStore, useIsSending } from "../../stores/index.js";
import { useActiveTrace } from "../../stores/chat-selectors.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { listCoauthorModulesAction, setCoauthorModuleAction } from "../../stores/api-actions/chat-actions.js";

export function useCoauthorInputArea() {
	const { t } = useT();

	// --- Controller + store subscriptions (mirrors RP InputArea's subset) ---
	const chat = useChatController();
	const binding = useCoauthorProviderBinding();
	const draft = useChatStore((s) => s.draft);
	const setDraft = useChatStore((s) => s.setDraft);
	const isSending = useIsSending();
	const connection = useProviderStore((s) => s.connection);
	const activeChatId = useChatStore((s) => s.activeChatId);

	// Co-Author readiness: the binding provides profile + model. The connection
	// probe is RP-only, but Co-Author generation works as long as the binding
	// resolves a profile with an endpoint + model (the adapter resolves it).
	const canUseLiveApi = binding.isReady;
	const canSend = Boolean(draft.trim()) && !isSending && canUseLiveApi;

	// --- Co-Author-scoped favorites, including supported/unknown/unsupported rows ---
	const activeProfileId = binding.profileId;
	const favorites = binding.favorites;
	const activeModelId = binding.model;

	const handleSelectModel = (modelId: string) => {
		void binding.quickSwitchModel(modelId);
	};

	// --- Send label state machine (same logic as RP InputArea, minus attachments) ---
	function renderSendLabel(): string {
		if (isSending) return t("sending");
		if (canUseLiveApi && draft.trim()) return t("send_message");
		if (!canUseLiveApi) return t("send_unavailable");
		return t("type_a_message");
	}
	const sendLabel = renderSendLabel();
	const sendButtonText = canSend || !draft.trim() ? t("send") : sendLabel || t("send_unavailable");

	// --- Token counting ---
	const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
	const TEMPORARY_TYPES = useMemo(() => new Set(["chat_history", "compaction"]), []);

	const buckets = useMemo(() => {
		const layers: PromptLayerDto[] = activePromptTrace?.layers ?? [];
		let moduleTokens = 0, skillTokens = 0, profileTokens = 0, context = 0, memory = 0, history = 0;
		for (const layer of layers) {
			if (!layer.enabled || layer.position === "hidden_system") continue;
			const tokens = layer.tokenCount;
			if (TEMPORARY_TYPES.has(layer.sourceType)) {
				history += tokens;
			} else {
				switch (layer.sourceType) {
					case "coauthor_module": moduleTokens += tokens; break;
					case "coauthor_skill": skillTokens += tokens; break;
					case "coauthor_profile": profileTokens += tokens; break;
					// CE-C1: pinned Level-1 context (was `lore_entry` under CA-13;
					// generalized to character/persona/lorebook/script).
					case "coauthor_context": context += tokens; break;
					case "summary_memory": memory += tokens; break;
					default: moduleTokens += tokens; break;
				}
			}
		}
		return { moduleTokens, skillTokens, profileTokens, context, memory, history };
	}, [activePromptTrace?.layers, TEMPORARY_TYPES]);

	const inputTokens = useTokenCount(draft);
	const permanent = buckets.moduleTokens + buckets.skillTokens + buckets.profileTokens + buckets.context + buckets.memory;
	const contextSize = binding.profile?.contextBudget ?? 0;
	const maxTokens = binding.profile?.maxTokens ?? 0;
	const totalUsed = permanent + buckets.history + inputTokens;
	const availableBudget = Math.max(0, contextSize - maxTokens);
	const usageRatio = availableBudget > 0 ? totalUsed / availableBudget : 0;
	// Annotated (not inferred) so the narrow union survives object-property
	// widening in the return type — `TokenCounterPopover` expects the literal
	// union, not `string`. RP InputArea computes the same inline and avoids
	// widening because its `const` never passes through an object property.
	const tokenState: "ok" | "mid" | "warn" = usageRatio > 0.95 ? "warn" : usageRatio > 0.75 ? "mid" : "ok";

	return {
		t,
		chat,
		draft, setDraft, isSending, activeChatId, canUseLiveApi, canSend,
		activeProfileId, favorites, activeModelId, handleSelectModel,
		sendLabel, sendButtonText,
		buckets, inputTokens, permanent, contextSize, maxTokens, availableBudget, tokenState,
	};
}

export type CoauthorInputAreaData = ReturnType<typeof useCoauthorInputArea>;

/** Quick module switch — a compact dropdown of module names (no modal).
 *  Consumed by both the desktop and mobile shells. Reads the snapshot store's
 *  active chat + the backend module registry; mirrors the registry's null→default
 *  fallback so the active row is highlighted even when no module was explicitly
 *  chosen. */
export function useModuleSwitch() {
	const { t } = useT();
	const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
	const rawActiveModuleId = useSnapshotStore((s) => s.activeChat?.coauthorModuleId ?? null);
	// Mirror the backend registry's null→default fallback so the active row is
	// highlighted even when no module has been explicitly chosen.
	const activeModuleId = rawActiveModuleId ?? "default";

	const [modules, setModules] = useState<CoauthorModule[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		listCoauthorModulesAction()
			.then((list) => {
				if (!cancelled) setModules(list);
			})
			.catch(() => {
				if (!cancelled) setModules([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const activeModule = modules.find((m) => m.id === activeModuleId) ?? null;
	const activeLabel = activeModule?.name ?? t("coauthor.input.module_switch");

	const handleSelect = async (moduleId: string) => {
		if (!chatId) return;
		await setCoauthorModuleAction(chatId, moduleId);
	};

	return { modules, loading, activeModuleId, activeLabel, handleSelect };
}
