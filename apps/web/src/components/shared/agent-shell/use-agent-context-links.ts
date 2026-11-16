import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ExperienceCopilotContextLink, ExperienceCopilotContextTargetType } from "@vibe-tavern/api-contracts";
import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import { useT } from "../../../i18n/context.js";
import type { MentionAutocompleteItem } from "../mention-autocomplete-query.js";
import type { AgentContextPillItem } from "./AgentContextPills.js";

export function useAgentContextLinks(threadId: string | null, transport: AgentHostTransport, catalog: MentionAutocompleteItem[]) {
	const { t } = useT();
	// ── Pinned context (CX-6) ───────────────────────────────────────────────
	// The thread's contextLinks (from every thread wire that arrives) + the
	// merged mention catalog. Pins are optimistically PATCHed (full-replace).
	const [contextLinks, setContextLinks] = useState<ExperienceCopilotContextLink[]>([]);
	// Pills: resolve each link's display label from the catalog; a dangling
	// target (deleted entity) falls back to the raw id.
	const pinnedContext = useMemo<AgentContextPillItem[]>(
		() =>
			contextLinks.map((l) => ({
				targetType: l.targetType,
				targetId: l.targetId,
				label: catalog.find((c) => c.targetType === l.targetType && c.id === l.targetId)?.label ?? l.targetId,
			})),
		[contextLinks, catalog],
	);

	// Optimistic full-replace PATCH: the pills update immediately; on failure
	// they revert to the previous set and a toast surfaces (the next turn would
	// otherwise run with server-state ≠ UI).
	const handleSetContextLinks = useCallback(
		(next: ExperienceCopilotContextLink[]) => {
			if (!threadId) return;
			const prev = contextLinks;
			setContextLinks(next);
			void transport.setContextLinks(threadId, next).catch(() => {
				setContextLinks(prev);
				toast.error(t("copilot_context_pin_error"));
			});
		},
		[threadId, contextLinks, transport, t],
	);

	const handlePinContext = useCallback(
		(item: MentionAutocompleteItem) => {
			if (contextLinks.length >= 64) return; // schema max — the PATCH would 400
			if (contextLinks.some((l) => l.targetType === item.targetType && l.targetId === item.id)) return; // already pinned
			// Narrow cast: the catalog is built in this shell from the six fixed
			// target types only (see the catalog effect and the sidechat-gated
			// preset fold), so the generic MentionAutocompleteItem.targetType is
			// always a valid link type here.
			handleSetContextLinks([
				...contextLinks,
				{ targetType: item.targetType as ExperienceCopilotContextTargetType, targetId: item.id },
			]);
		},
		[contextLinks, handleSetContextLinks],
	);

	const handleUnpinContext = useCallback(
		(targetType: string, targetId: string) => {
			handleSetContextLinks(
				contextLinks.filter((l) => !(l.targetType === targetType && l.targetId === targetId)),
			);
		},
		[contextLinks, handleSetContextLinks],
	);

	const clearSubmittedPresets = useCallback((presetIds: readonly string[]) => {
		const submitted = new Set(presetIds);
		setContextLinks((current) => current.filter((link) => link.targetType !== "prompt_preset" || !submitted.has(link.targetId)));
	}, []);

	return { contextLinks, setContextLinks, pinnedContext, handlePinContext, handleUnpinContext, clearSubmittedPresets };
}
