import { useT } from '../../../i18n/context.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { GENERATION_MODE, resolveNativeTextCompletion, resolveTextCompletionSupport, type AutoTemplateSource } from '@vibe-tavern/domain';
import type { GenerationMode } from '@vibe-tavern/domain';
import { ProviderFormatPanel } from './ProviderFormatPanel.js';

interface ProviderGenerationModePanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  /** Where AUTO takes its template for this preset (LS-3c) — feeds the format
   *  block's status line + the native-TC always-render gate (LS-10). */
  tcTemplateSource: AutoTemplateSource;
}

/**
 * Generation-format toggle (LOCAL_SUPPORT_PLAN LS-2a) — «Формат генерации».
 *
 * Chooses how the server talks to this provider's backend: chat completions
 * (default) or raw text completion (one flat prompt string to `/completions`).
 * The flip is SILENT and fully backward-compatible: nothing in the chat,
 * presets, or history is rewritten, and flipping back is instant.
 *
 * Visible for presets whose backend serves a completion endpoint
 * (llama.cpp, LM Studio, ooba/TabbyAPI/Aphrodite/vLLM, generic openai_compat)
 * — `resolveTextCompletionSupport` is the shared fail-closed gate (clouds,
 * ollama, and the cloud-native protocols hide the toggle entirely).
 *
 * LS-10: the format block (ProviderFormatPanel) parks DIRECTLY UNDER this
 * switch — rendered in Текст mode, and ALWAYS for the native-TC preset
 * (KoboldCPP has no switch but is always text completion; owner option A).
 */
export function ProviderGenerationModePanel({ form, updateForm, tcTemplateSource }: ProviderGenerationModePanelProps) {
  const { t } = useT();
  const textCompletion = resolveTextCompletionSupport(form.providerPreset).supported;
  const nativeTc = tcTemplateSource === "native";
  if (!textCompletion && !nativeTc) return null;
  const formatBlockVisible = nativeTc || form.generationMode === GENERATION_MODE.completion;

  return (
    <div className="mt-4">
      {textCompletion && (
        <>
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
        </>
      )}

      {/* LS-10: the format block lives HERE (under the mode switch) — in Текст
          mode, and always for native-TC KoboldCPP. */}
      {formatBlockVisible && (
        <ProviderFormatPanel
          form={form}
          updateForm={updateForm}
          tcTemplateSource={tcTemplateSource}
        />
      )}
    </div>
  );
}
