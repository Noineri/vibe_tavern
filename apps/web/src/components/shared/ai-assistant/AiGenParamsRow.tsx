import { Icons } from "../icons.js";
import { NumberInput } from "../NumberInput.js";
import { AnimatedDisclosure } from "../AnimatedDisclosure.js";
import { usePersistedBoolean } from "../../../hooks/use-persisted-boolean.js";
import { useT } from "../../../i18n/context.js";

const lblCls = "mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";

export interface AiGenParamsRowProps {
  /** Resolved temperature (per-mode defaults applied at the call site). */
  temperature: number;
  onTemperatureChange: (value: number) => void;
  /** Resolved max output tokens (per-mode defaults applied at the call site). */
  maxTokens: number;
  onMaxTokensChange: (value: number) => void;
  /** Optional recent-messages control (chat message editor only). Keeps its steppers. */
  recentMessages?: { value: number; onChange: (value: number) => void };
}

/**
 * Shared generation-params area for the AI-assistant modals: a persisted,
 * default-collapsed "Advanced settings" accordion holding temperature
 * (hybrid slider + typable field, two-way synced) and max-tokens, plus an
 * optional recent-messages field.
 *
 * Chrome follows the VibeMdView Accordion pattern: bordered container,
 * full-width trigger row with `aria-expanded`, `Icons.Caret` flip, content
 * KEPT MOUNTED and toggled via a `hidden` class (NOT conditional unmount) —
 * slider/field state survives collapse and the existing label assertions in
 * `MessageAiEditorModal.test.tsx` keep passing. Open state persists globally
 * (both modals share it) via `usePersistedBoolean`.
 *
 * AI_ASSISTANT_SHELL_REFACTOR_REPORT Step 2 + AI_ASSISTANT_MODAL_REDESIGN_REPORT
 * (landed as one component, one commit, per the redesign report's convergence).
 */
export function AiGenParamsRow({
  temperature,
  onTemperatureChange,
  maxTokens,
  onMaxTokensChange,
  recentMessages,
}: AiGenParamsRowProps) {
  const { t } = useT();
  const [isOpen, setIsOpen] = usePersistedBoolean("ai:gen-params:open", false);

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-s2">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between bg-surface px-4 py-2.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-colors hover:bg-s2"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
      >
        <span>{t("ai_advanced_settings")}</span>
        <Icons.Caret direction={isOpen ? "d" : "l"} />
      </button>
      <AnimatedDisclosure open={isOpen} keepMounted className="px-4">
        <div className="space-y-3 py-4">
          {/* Temperature — hybrid: slider for nudging + typable field for exact values */}
          <div>
            <label className={lblCls}>{t("ai_param_temperature")}</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => onTemperatureChange(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <NumberInput
                min={0}
                max={2}
                step={0.1}
                hideControls
                value={temperature}
                onChange={onTemperatureChange}
                className="w-16 shrink-0"
              />
            </div>
          </div>
          {/* Max tokens (+ optional recent messages) — no steppers on max-tokens */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lblCls}>{t("ai_param_max_tokens")}</label>
              <NumberInput min={256} max={64000} hideControls value={maxTokens} onChange={onMaxTokensChange} className="w-full" />
            </div>
            {recentMessages && (
              <div>
                <label className={lblCls}>{t("ai_quickpill_recent_messages")}</label>
                <NumberInput min={1} max={100} value={recentMessages.value} onChange={recentMessages.onChange} className="w-full" />
              </div>
            )}
          </div>
        </div>
      </AnimatedDisclosure>
    </div>
  );
}
