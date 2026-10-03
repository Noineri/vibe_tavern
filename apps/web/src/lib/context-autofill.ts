/**
 * Context-budget auto-fill is shared by RP and Co-Author model selection.
 * A pinned budget is always user-owned; otherwise a known model context wins
 * and each surface supplies its own unknown-model fallback.
 */
export const RP_UNKNOWN_CONTEXT_BUDGET = 16_000;
/** Backwards-compatible name for the RP form's shipped default. */
export const DEFAULT_CONTEXT_BUDGET = RP_UNKNOWN_CONTEXT_BUDGET;

export function resolveModelContextBudget(input: {
	pinned: boolean;
	contextLength: number | null | undefined;
	unknownContextBudget: number;
}): number | undefined {
	if (input.pinned) return undefined;
	return input.contextLength != null && Number.isFinite(input.contextLength) && input.contextLength > 0
		? input.contextLength
		: input.unknownContextBudget;
}

export function shouldAutoFillContextBudget(input: { pinned: boolean; formValue: number }): boolean {
	return !input.pinned && input.formValue === DEFAULT_CONTEXT_BUDGET;
}

/** Pick the model whose context should drive the fill (selected, else first). */
export function pickContextSourceModelId(selectedModel: string | undefined, models: Array<{ id: string; contextLength?: number }>): string | undefined {
	if (selectedModel && models.some((m) => m.id === selectedModel)) return selectedModel;
	return models[0]?.id;
}
