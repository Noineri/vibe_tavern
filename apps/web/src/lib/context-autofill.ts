/**
 * LS-7 — when the model list populates, the profile's context budget may be
 * auto-filled from the selected model's real context length (llama-server
 * /props, LM Studio /v1/models, OpenRouter & co.). The fill must never fight
 * the user:
 *
 * - a PINNED budget is the user's explicit "hands off" — never rewritten;
 * - the only fillable state is the field still showing the shipped default
 *   (16 000): either the profile row was never saved (the form coerces its
 *   null budget to the default) or it was saved once without intent by some
 *   other field's autosave flush. ANY other in-form value — typed by the user
 *   or picked via the model selector — counts as "touched" and is left alone.
 *   The pin is the documented escape hatch for keeping the default too.
 */
export const DEFAULT_CONTEXT_BUDGET = 16_000;

export function shouldAutoFillContextBudget(input: { pinned: boolean; formValue: number }): boolean {
	return !input.pinned && input.formValue === DEFAULT_CONTEXT_BUDGET;
}

/** Pick the model whose context should drive the fill (selected, else first). */
export function pickContextSourceModelId(selectedModel: string | undefined, models: Array<{ id: string; contextLength?: number }>): string | undefined {
	if (selectedModel && models.some((m) => m.id === selectedModel)) return selectedModel;
	return models[0]?.id;
}
