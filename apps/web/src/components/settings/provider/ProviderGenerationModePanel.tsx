import { useT } from '../../../i18n/context.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { GENERATION_MODE, resolveTextCompletionSupport } from '@vibe-tavern/domain';
import type { GenerationMode } from '@vibe-tavern/domain';

interface ProviderGenerationModePanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

/**
 * Generation-format toggle (LOCAL_SUPPORT_PLAN LS-2a) — «Формат генерации».
 *
 * Chooses how the server talks to this provider's backend: chat completions
 * (default) or raw text completion (one flat prompt string to `/completions`).
 * The flip is SILENT and fully backward-compatible: nothing in the chat,
 * presets, or history is rewritten, and flipping back is instant.
 *
 * Visible ONLY for presets whose backend serves a completion endpoint
 * (llama.cpp, LM Studio, ooba/TabbyAPI/Aphrodite/vLLM, generic openai_compat)
 * — `resolveTextCompletionSupport` is the shared fail-closed gate (clouds,
 * KoboldCPP's always-native TC, ollama, and the cloud-native protocols hide
 * the toggle entirely).
 */
export function ProviderGenerationModePanel({ form, updateForm }: ProviderGenerationModePanelProps) {
  const { t } = useT();
  if (!resolveTextCompletionSupport(form.providerPreset).supported) return null;

  return (
    <div className="mt-4">
      <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        {t("generation_format")}
      </label>
      <SegmentedControl<GenerationMode>
        value={form.generationMode}
        options={[
          { value: GENERATION_MODE.chat, label: t("generation_mode_chat") },
          { value: GENERATION_MODE.completion, label: t("generation_mode_completion") },
        ]}
        onChange={(v) => updateForm('generationMode', v)}
      />
      <div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 italic">
        {t("generation_format_hint")}
      </div>
    </div>
  );
}
