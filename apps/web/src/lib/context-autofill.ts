/**
 * Context-budget auto-fill is shared by RP and Co-Author model selection.
 * A pinned budget is always user-owned; otherwise a known model context wins.
 * An unknown model context keeps an already-set budget untouched and fills the
 * per-surface fallback only when NO budget is set at all (owner 2026-10-04,
 * RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 3 — interim until the model
 * capability oracle fills unknown lengths).
 */
export const RP_UNKNOWN_CONTEXT_BUDGET = 16_000;
/** Backwards-compatible name for the RP form's shipped default. */
export const DEFAULT_CONTEXT_BUDGET = RP_UNKNOWN_CONTEXT_BUDGET;

export function resolveModelContextBudget(input: {
	pinned: boolean;
	contextLength: number | null | undefined;
	unknownContextBudget: number;
	/** Budget the surface already carries (form value, profile base, or
	 *  Co-Author row). "Set" means a finite positive value; null/undefined
	 *  means no budget at all. */
	currentBudget: number | null | undefined;
}): number | undefined {
	if (input.pinned) return undefined;
	if (input.contextLength != null && Number.isFinite(input.contextLength) && input.contextLength > 0) {
		return input.contextLength;
	}
	// Unknown model context: an already-set budget is provider-owned and stays
	// (owner 2026-10-04); the surface fallback applies only when NO budget is
	// set at all. Returning undefined means "leave the budget unchanged".
	const hasBudget = input.currentBudget != null && Number.isFinite(input.currentBudget) && input.currentBudget > 0;
	return hasBudget ? undefined : input.unknownContextBudget;
}

export function shouldAutoFillContextBudget(input: { pinned: boolean; formValue: number }): boolean {
	return !input.pinned && input.formValue === DEFAULT_CONTEXT_BUDGET;
}

/** Pick the model whose context should drive the fill (selected, else first). */
export function pickContextSourceModelId(selectedModel: string | undefined, models: Array<{ id: string; contextLength?: number }>): string | undefined {
	if (selectedModel && models.some((m) => m.id === selectedModel)) return selectedModel;
	return models[0]?.id;
}
